#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env,
};

const MIN_INTENT_LIFETIME_SECONDS: u64 = 30;
const MAX_INTENT_LIFETIME_SECONDS: u64 = 86_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub token: Address,
    pub relayer: Address,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Merchant {
    pub account: Address,
    pub active: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PaymentStatus {
    Created,
    Confirmed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentIntent {
    pub payer: Address,
    pub merchant_id: BytesN<32>,
    pub merchant: Address,
    pub amount: i128,
    pub memo_hash: BytesN<32>,
    pub expires_at: u64,
    pub created_at: u64,
    pub status: PaymentStatus,
    pub payment_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Merchant(BytesN<32>),
    Intent(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Paused = 3,
    InvalidAmount = 4,
    InvalidExpiry = 5,
    MerchantMissing = 6,
    MerchantInactive = 7,
    IntentExists = 8,
    IntentMissing = 9,
    IntentExpired = 10,
    InvalidStatus = 11,
    MerchantExists = 12,
    IntentLifetimeTooLong = 13,
    PayerMismatch = 14,
}

#[contractevent(topics = ["config", "init"], data_format = "vec")]
pub struct ConfigInitialized {
    pub admin: Address,
    pub token: Address,
    pub relayer: Address,
}

#[contractevent(topics = ["config", "admin"], data_format = "single-value")]
pub struct AdminSet {
    pub admin: Address,
}

#[contractevent(topics = ["config", "token"], data_format = "single-value")]
pub struct TokenSet {
    pub token: Address,
}

#[contractevent(topics = ["config", "relayer"], data_format = "single-value")]
pub struct RelayerSet {
    pub relayer: Address,
}

#[contractevent(topics = ["config", "paused"], data_format = "single-value")]
pub struct PausedSet {
    pub paused: bool,
}

#[contractevent(topics = ["merchant", "register"], data_format = "vec")]
pub struct MerchantRegistered {
    #[topic]
    pub merchant_id: BytesN<32>,
    pub account: Address,
    pub active: bool,
}

#[contractevent(topics = ["merchant", "account"], data_format = "vec")]
pub struct MerchantAccountSet {
    #[topic]
    pub merchant_id: BytesN<32>,
    pub account: Address,
}

#[contractevent(topics = ["merchant", "active"], data_format = "single-value")]
pub struct MerchantActiveSet {
    #[topic]
    pub merchant_id: BytesN<32>,
    pub active: bool,
}

#[contractevent(topics = ["intent", "create"], data_format = "vec")]
pub struct IntentCreated {
    #[topic]
    pub intent_id: BytesN<32>,
    pub payer: Address,
    pub merchant_id: BytesN<32>,
    pub merchant: Address,
    pub amount: i128,
    pub expires_at: u64,
    pub memo_hash: BytesN<32>,
}

#[contractevent(topics = ["intent", "confirm"], data_format = "vec")]
pub struct IntentConfirmed {
    #[topic]
    pub intent_id: BytesN<32>,
    pub payment_hash: BytesN<32>,
}

#[contractevent(topics = ["intent", "cancel"], data_format = "single-value")]
pub struct IntentCancelled {
    #[topic]
    pub intent_id: BytesN<32>,
    pub payer: Address,
}

#[contract]
pub struct CPayPayments;

#[contractimpl]
impl CPayPayments {
    pub fn __constructor(env: Env, admin: Address, token: Address, relayer: Address) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }

        let config = Config {
            admin,
            token,
            relayer,
            paused: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        extend_instance_ttl(&env);
        ConfigInitialized {
            admin: config.admin.clone(),
            token: config.token.clone(),
            relayer: config.relayer.clone(),
        }
        .publish(&env);
    }

    pub fn config(env: Env) -> Result<Config, Error> {
        extend_instance_ttl(&env);
        read_config(&env)
    }

    pub fn set_admin(env: Env, admin: Address) -> Result<(), Error> {
        let updated = update_config(&env, |mut config| {
            config.admin.require_auth();
            config.admin = admin.clone();
            config
        })?;

        AdminSet {
            admin: updated.admin,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_token(env: Env, token: Address) -> Result<(), Error> {
        let updated = update_config(&env, |mut config| {
            config.admin.require_auth();
            config.token = token.clone();
            config
        })?;

        TokenSet {
            token: updated.token,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_relayer(env: Env, relayer: Address) -> Result<(), Error> {
        let updated = update_config(&env, |mut config| {
            config.admin.require_auth();
            config.relayer = relayer.clone();
            config
        })?;

        RelayerSet {
            relayer: updated.relayer,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        update_config(&env, |mut config| {
            config.admin.require_auth();
            config.paused = paused;
            config
        })?;

        PausedSet { paused }.publish(&env);
        Ok(())
    }

    pub fn register_merchant(
        env: Env,
        merchant_id: BytesN<32>,
        account: Address,
    ) -> Result<Merchant, Error> {
        require_admin(&env)?;

        let now = env.ledger().timestamp();
        let key = DataKey::Merchant(merchant_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::MerchantExists);
        }

        let merchant = Merchant {
            account,
            active: true,
            created_at: now,
            updated_at: now,
        };

        env.storage().persistent().set(&key, &merchant);
        extend_persistent_ttl(&env, &key);
        MerchantRegistered {
            merchant_id,
            account: merchant.account.clone(),
            active: merchant.active,
        }
        .publish(&env);

        Ok(merchant)
    }

    pub fn set_merchant_account(
        env: Env,
        merchant_id: BytesN<32>,
        account: Address,
    ) -> Result<Merchant, Error> {
        require_admin(&env)?;

        let key = DataKey::Merchant(merchant_id.clone());
        let mut merchant = read_merchant(&env, &merchant_id)?;
        merchant.account = account;
        merchant.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &merchant);
        extend_persistent_ttl(&env, &key);
        MerchantAccountSet {
            merchant_id,
            account: merchant.account.clone(),
        }
        .publish(&env);

        Ok(merchant)
    }

    pub fn set_merchant_active(
        env: Env,
        merchant_id: BytesN<32>,
        active: bool,
    ) -> Result<Merchant, Error> {
        require_admin(&env)?;

        let key = DataKey::Merchant(merchant_id.clone());
        let mut merchant = read_merchant(&env, &merchant_id)?;
        merchant.active = active;
        merchant.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &merchant);
        extend_persistent_ttl(&env, &key);
        MerchantActiveSet {
            merchant_id,
            active,
        }
        .publish(&env);

        Ok(merchant)
    }

    pub fn merchant(env: Env, merchant_id: BytesN<32>) -> Result<Merchant, Error> {
        let key = DataKey::Merchant(merchant_id.clone());
        extend_persistent_ttl(&env, &key);
        read_merchant(&env, &merchant_id)
    }

    pub fn create_intent(
        env: Env,
        payer: Address,
        merchant_id: BytesN<32>,
        intent_id: BytesN<32>,
        amount: i128,
        expires_at: u64,
        memo_hash: BytesN<32>,
    ) -> Result<PaymentIntent, Error> {
        payer.require_auth();
        require_not_paused(&env)?;

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        if expires_at <= now.saturating_add(MIN_INTENT_LIFETIME_SECONDS) {
            return Err(Error::InvalidExpiry);
        }
        if expires_at > now.saturating_add(MAX_INTENT_LIFETIME_SECONDS) {
            return Err(Error::IntentLifetimeTooLong);
        }

        let intent_key = DataKey::Intent(intent_id.clone());
        if env.storage().temporary().has(&intent_key) {
            return Err(Error::IntentExists);
        }

        let merchant = read_merchant(&env, &merchant_id)?;
        if !merchant.active {
            return Err(Error::MerchantInactive);
        }

        let intent = PaymentIntent {
            payer,
            merchant_id,
            merchant: merchant.account,
            amount,
            memo_hash,
            expires_at,
            created_at: now,
            status: PaymentStatus::Created,
            payment_hash: None,
        };

        env.storage().temporary().set(&intent_key, &intent);
        extend_temporary_ttl(&env, &intent_key);
        IntentCreated {
            intent_id,
            payer: intent.payer.clone(),
            merchant_id: intent.merchant_id.clone(),
            merchant: intent.merchant.clone(),
            amount: intent.amount,
            expires_at: intent.expires_at,
            memo_hash: intent.memo_hash.clone(),
        }
        .publish(&env);

        Ok(intent)
    }

    pub fn confirm_intent(
        env: Env,
        intent_id: BytesN<32>,
        payment_hash: BytesN<32>,
    ) -> Result<PaymentIntent, Error> {
        let config = read_config(&env)?;
        config.relayer.require_auth();
        require_not_paused_with_config(&env, &config)?;

        let key = DataKey::Intent(intent_id.clone());
        let mut intent = read_intent(&env, &intent_id)?;

        if intent.status != PaymentStatus::Created {
            return Err(Error::InvalidStatus);
        }

        if intent.expires_at <= env.ledger().timestamp() {
            return Err(Error::IntentExpired);
        }

        intent.status = PaymentStatus::Confirmed;
        intent.payment_hash = Some(payment_hash.clone());

        env.storage().temporary().set(&key, &intent);
        extend_temporary_ttl(&env, &key);
        IntentConfirmed {
            intent_id,
            payment_hash,
        }
        .publish(&env);

        Ok(intent)
    }

    pub fn cancel_intent(
        env: Env,
        payer: Address,
        intent_id: BytesN<32>,
    ) -> Result<PaymentIntent, Error> {
        payer.require_auth();

        let key = DataKey::Intent(intent_id.clone());
        let mut intent = read_intent(&env, &intent_id)?;

        if intent.payer != payer {
            return Err(Error::PayerMismatch);
        }

        if intent.status != PaymentStatus::Created {
            return Err(Error::InvalidStatus);
        }

        intent.status = PaymentStatus::Cancelled;

        env.storage().temporary().set(&key, &intent);
        extend_temporary_ttl(&env, &key);
        IntentCancelled { intent_id, payer }.publish(&env);

        Ok(intent)
    }

    pub fn intent(env: Env, intent_id: BytesN<32>) -> Result<PaymentIntent, Error> {
        let key = DataKey::Intent(intent_id.clone());
        extend_temporary_ttl(&env, &key);
        read_intent(&env, &intent_id)
    }

    pub fn extend_ttl(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        extend_instance_ttl(&env);
        Ok(())
    }
}

fn read_config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

fn update_config(env: &Env, update: impl FnOnce(Config) -> Config) -> Result<Config, Error> {
    let config = read_config(env)?;
    let updated = update(config);
    env.storage().instance().set(&DataKey::Config, &updated);
    extend_instance_ttl(env);
    Ok(updated)
}

fn require_admin(env: &Env) -> Result<Config, Error> {
    let config = read_config(env)?;
    config.admin.require_auth();
    extend_instance_ttl(env);
    Ok(config)
}

fn require_not_paused(env: &Env) -> Result<Config, Error> {
    let config = read_config(env)?;
    require_not_paused_with_config(env, &config)?;
    Ok(config)
}

fn require_not_paused_with_config(env: &Env, config: &Config) -> Result<(), Error> {
    extend_instance_ttl(env);
    if config.paused {
        return Err(Error::Paused);
    }
    Ok(())
}

fn read_merchant(env: &Env, merchant_id: &BytesN<32>) -> Result<Merchant, Error> {
    let key = DataKey::Merchant(merchant_id.clone());
    let merchant = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::MerchantMissing)?;
    extend_persistent_ttl(env, &key);
    Ok(merchant)
}

fn read_intent(env: &Env, intent_id: &BytesN<32>) -> Result<PaymentIntent, Error> {
    let key = DataKey::Intent(intent_id.clone());
    let intent = env
        .storage()
        .temporary()
        .get(&key)
        .ok_or(Error::IntentMissing)?;
    extend_temporary_ttl(env, &key);
    Ok(intent)
}

fn extend_instance_ttl(env: &Env) {
    let max_ttl = env.storage().max_ttl();
    env.storage().instance().extend_ttl(max_ttl / 2, max_ttl);
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, max_ttl / 2, max_ttl);
}

fn extend_temporary_ttl(env: &Env, key: &DataKey) {
    let max_ttl = env.storage().max_ttl();
    env.storage()
        .temporary()
        .extend_ttl(key, max_ttl / 2, max_ttl);
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        BytesN, Env,
    };

    fn id(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    fn setup<'a>(
        env: &'a Env,
    ) -> (
        CPayPaymentsClient<'a>,
        Address,
        Address,
        Address,
        Address,
        Address,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let token = Address::generate(env);
        let relayer = Address::generate(env);
        let merchant = Address::generate(env);
        let payer = Address::generate(env);
        let contract_id = env.register(CPayPayments, (&admin, &token, &relayer));
        let client = CPayPaymentsClient::new(env, &contract_id);

        (client, admin, token, relayer, merchant, payer)
    }

    #[test]
    fn registers_merchant_and_tracks_payment_intent() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 1);
        let intent_id = id(&env, 2);
        let memo_hash = id(&env, 3);
        let payment_hash = id(&env, 4);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();

        let intent = client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &100_0000000_i128,
                &(env.ledger().timestamp() + 600),
                &memo_hash,
            )
            .unwrap()
            .unwrap();

        assert_eq!(intent.status, PaymentStatus::Created);
        assert_eq!(intent.amount, 100_0000000_i128);

        let confirmed = client
            .try_confirm_intent(&intent_id, &payment_hash)
            .unwrap()
            .unwrap();

        assert_eq!(confirmed.status, PaymentStatus::Confirmed);
        assert_eq!(confirmed.payment_hash, Some(payment_hash));
    }

    #[test]
    fn blocks_inactive_merchants() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 5);
        let intent_id = id(&env, 6);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        client
            .try_set_merchant_active(&merchant_id, &false)
            .unwrap()
            .unwrap();

        let result = client.try_create_intent(
            &payer,
            &merchant_id,
            &intent_id,
            &50_i128,
            &(env.ledger().timestamp() + 600),
            &id(&env, 7),
        );

        assert_eq!(result, Err(Ok(Error::MerchantInactive)));
    }

    #[test]
    fn rejects_duplicate_merchants_and_rotates_account_explicitly() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, _payer) = setup(&env);

        let merchant_id = id(&env, 8);
        let replacement = Address::generate(&env);

        let original = client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_register_merchant(&merchant_id, &replacement),
            Err(Ok(Error::MerchantExists))
        );

        let updated = client
            .try_set_merchant_account(&merchant_id, &replacement)
            .unwrap()
            .unwrap();

        assert_eq!(updated.account, replacement);
        assert_eq!(updated.created_at, original.created_at);
        assert!(updated.updated_at >= original.updated_at);
    }

    #[test]
    fn enforces_intent_expiry_bounds_and_duplicate_ids() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 9);
        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 10),
                &50_i128,
                &(env.ledger().timestamp() + MIN_INTENT_LIFETIME_SECONDS),
                &id(&env, 11),
            ),
            Err(Ok(Error::InvalidExpiry))
        );

        assert_eq!(
            client.try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 12),
                &50_i128,
                &(env.ledger().timestamp() + MAX_INTENT_LIFETIME_SECONDS + 1),
                &id(&env, 13),
            ),
            Err(Ok(Error::IntentLifetimeTooLong))
        );

        client
            .try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 14),
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 15),
            )
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 14),
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 16),
            ),
            Err(Ok(Error::IntentExists))
        );
    }

    #[test]
    fn pause_blocks_new_and_confirmed_intents() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 17);
        let intent_id = id(&env, 18);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 19),
            )
            .unwrap()
            .unwrap();
        client.try_set_paused(&true).unwrap().unwrap();

        assert_eq!(
            client.try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 20),
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 21),
            ),
            Err(Ok(Error::Paused))
        );
        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 22)),
            Err(Ok(Error::Paused))
        );
    }

    #[test]
    fn payer_can_cancel_created_intent() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 23);
        let intent_id = id(&env, 24);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 25),
            )
            .unwrap()
            .unwrap();

        let stranger = Address::generate(&env);
        assert_eq!(
            client.try_cancel_intent(&stranger, &intent_id),
            Err(Ok(Error::PayerMismatch))
        );

        let cancelled = client
            .try_cancel_intent(&payer, &intent_id)
            .unwrap()
            .unwrap();

        assert_eq!(cancelled.status, PaymentStatus::Cancelled);
        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 26)),
            Err(Ok(Error::InvalidStatus))
        );
    }

    #[test]
    fn rejects_invalid_amount_and_unknown_merchant() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, _merchant, payer) = setup(&env);

        assert_eq!(
            client.try_create_intent(
                &payer,
                &id(&env, 27),
                &id(&env, 28),
                &0_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 29),
            ),
            Err(Ok(Error::InvalidAmount))
        );

        assert_eq!(
            client.try_create_intent(
                &payer,
                &id(&env, 30),
                &id(&env, 31),
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 32),
            ),
            Err(Ok(Error::MerchantMissing))
        );
    }

    #[test]
    fn rejects_confirmation_after_intent_expiry() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 33);
        let intent_id = id(&env, 34);
        let expires_at = env.ledger().timestamp() + 600;

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &50_i128,
                &expires_at,
                &id(&env, 35),
            )
            .unwrap()
            .unwrap();

        env.ledger().set_timestamp(expires_at);

        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 36)),
            Err(Ok(Error::IntentExpired))
        );
    }

    // ── Edge-case tests ────────────────────────────────────────────────────

    /// Double-confirm: confirming an already-Confirmed intent must return
    /// `InvalidStatus`, not silently overwrite the payment hash.
    #[test]
    fn rejects_double_confirm() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 40);
        let intent_id = id(&env, 41);
        let payment_hash_1 = id(&env, 42);
        let payment_hash_2 = id(&env, 43);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 44),
            )
            .unwrap()
            .unwrap();

        // First confirm — must succeed
        let confirmed = client
            .try_confirm_intent(&intent_id, &payment_hash_1)
            .unwrap()
            .unwrap();
        assert_eq!(confirmed.status, PaymentStatus::Confirmed);
        assert_eq!(confirmed.payment_hash, Some(payment_hash_1.clone()));

        // Second confirm on the same intent — must be rejected
        assert_eq!(
            client.try_confirm_intent(&intent_id, &payment_hash_2),
            Err(Ok(Error::InvalidStatus))
        );

        // Original payment hash must be preserved
        let persisted = client.try_intent(&intent_id).unwrap().unwrap();
        assert_eq!(persisted.payment_hash, Some(payment_hash_1));
    }

    /// Cancel-after-confirm: a Confirmed intent cannot be cancelled.
    #[test]
    fn rejects_cancel_after_confirm() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 45);
        let intent_id = id(&env, 46);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 47),
            )
            .unwrap()
            .unwrap();
        client
            .try_confirm_intent(&intent_id, &id(&env, 48))
            .unwrap()
            .unwrap();

        // Cancel must now be rejected with InvalidStatus
        assert_eq!(
            client.try_cancel_intent(&payer, &intent_id),
            Err(Ok(Error::InvalidStatus))
        );
    }

    /// Negative amount is rejected the same way as zero.
    #[test]
    fn rejects_negative_amount() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 49);
        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 50),
                &-1_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 51),
            ),
            Err(Ok(Error::InvalidAmount))
        );
    }

    /// Unpause: contract resumes accepting intents after being unpaused.
    #[test]
    fn unpause_resumes_intent_creation() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 52);
        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();

        // Pause
        client.try_set_paused(&true).unwrap().unwrap();
        assert_eq!(
            client.try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 53),
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 54),
            ),
            Err(Ok(Error::Paused))
        );

        // Unpause
        client.try_set_paused(&false).unwrap().unwrap();
        let intent = client
            .try_create_intent(
                &payer,
                &merchant_id,
                &id(&env, 55),
                &50_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 56),
            )
            .unwrap()
            .unwrap();
        assert_eq!(intent.status, PaymentStatus::Created);
    }

    /// read_config before initialization: calling config() before the
    /// constructor panics with NotInitialized.
    #[test]
    fn config_returns_not_initialized_before_constructor() {
        let env = Env::default();
        env.mock_all_auths();
        // Register the contract without calling the constructor by deploying
        // with no init args — this is not possible via the typed client, so we
        // directly instantiate and call config without a prior constructor.
        // We test the error path by deploying and immediately trying to read.
        let contract_id = env.register(CPayPayments, ());
        let client = CPayPaymentsClient::new(&env, &contract_id);
        assert_eq!(
            client.try_config(),
            Err(Ok(Error::NotInitialized))
        );
    }
}
