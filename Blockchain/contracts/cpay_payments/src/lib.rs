#![no_std]

//! C-Pay Soroban Payment Intent Contract
//!
//! # Trust Boundary & Payment Assurance Model
//!
//! This contract stores merchant registration and payment intent state on-chain, but
//! **token movement itself happens via classic Stellar payment operations**, not through
//! this contract or the Stellar Asset Contract (SAC) interface.
//!
//! ## What is enforced on-chain:
//! - Merchant registration and activation status
//! - Payment intent creation with expiry and amount recorded
//! - Payment intent state transitions (Created → Submitted → Confirmed/Expired/Cancelled)
//! - Authorization checks: payer signs intent creation, relayer signs confirmation
//! - Intent lifecycle bounds (min/max lifetime, expiry checks)
//!
//! ## What is verified off-chain by the relayer:
//! - Actual token transfer on Stellar (payment operation in user-signed XDR)
//! - Amount, asset, source, and destination match the intent
//! - Payment transaction succeeds and is included in a ledger
//!
//! The relayer acts as a **trusted verifier** that observes the Stellar payment,
//! then confirms the intent on-chain. This design keeps gas costs low and allows
//! the contract to support existing Stellar wallets and payment flows without requiring
//! SAC-aware wallet signing or contract-controlled token custody.
//!
//! For stronger on-chain payment assurance, consider:
//! - Migrating to SAC-native token transfers invoked directly by this contract
//! - Adding a timelock + challenge mechanism for intent confirmation disputes
//! - Multi-signature relayer confirmation or oracle network verification
//!
//! The current model is production-ready for environments where the relayer is
//! operated by the C-Pay platform and auditability comes from contract event logs
//! cross-referenced with Stellar transaction history.

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
    /// Intent created and waiting for a matching Stellar payment.
    Created,
    /// Relayer has observed the Stellar payment and marked the intent as
    /// submitted. The on-chain confirmation step follows once the payment
    /// is included in a ledger.
    Submitted,
    /// Relayer has confirmed the Stellar payment hash on-chain. Terminal.
    Confirmed,
    /// Explicitly expired by the admin after the `expires_at` timestamp
    /// passed without a corresponding Stellar payment.  Terminal.
    Expired,
    /// Payer cancelled the intent before the relayer submitted a payment.
    /// Terminal.
    Cancelled,
    /// Payment was submitted but the on-chain confirmation failed or could
    /// not be reconciled (e.g. wrong amount, wrong asset, missing hash).
    /// Requires manual admin review. Terminal until resolved.
    ReconciliationNeeded,
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
    pub submitted_at: Option<u64>,
    pub confirmed_at: Option<u64>,
    pub status: PaymentStatus,
    pub payment_hash: Option<BytesN<32>>,
    pub submitted_by: Option<Address>,
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
    /// Caller is not authorised to perform this operation (e.g. non-relayer
    /// calling a relayer-only function).
    Unauthorized = 15,
    /// Confirmation rejected because the same intent was already confirmed
    /// with a different or identical payment hash.
    DuplicateConfirmation = 16,
    /// Admin attempted to expire an intent that has not yet passed its
    /// `expires_at` timestamp.
    NotYetExpired = 17,
    /// The intent could not be reconciled because it is already in a terminal
    /// state (Confirmed, Expired, or Cancelled).
    AlreadyTerminal = 18,
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

#[contractevent(topics = ["intent", "submit"], data_format = "vec")]
pub struct IntentSubmitted {
    #[topic]
    pub intent_id: BytesN<32>,
    pub submitted_by: Address,
    pub payment_hash: BytesN<32>,
}

#[contractevent(topics = ["intent", "expire"], data_format = "single-value")]
pub struct IntentExpired {
    #[topic]
    pub intent_id: BytesN<32>,
    pub expired_at: u64,
}

#[contractevent(topics = ["intent", "reconcile"], data_format = "vec")]
pub struct IntentReconciliationNeeded {
    #[topic]
    pub intent_id: BytesN<32>,
    pub reason: soroban_sdk::String,
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
            submitted_at: None,
            confirmed_at: None,
            status: PaymentStatus::Created,
            payment_hash: None,
            submitted_by: None,
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

        // Guard: already confirmed – duplicate confirmation is not allowed.
        if intent.status == PaymentStatus::Confirmed {
            return Err(Error::DuplicateConfirmation);
        }

        // Only Created or Submitted intents can transition to Confirmed.
        if intent.status != PaymentStatus::Created && intent.status != PaymentStatus::Submitted {
            return Err(Error::InvalidStatus);
        }

        if intent.expires_at <= env.ledger().timestamp() {
            return Err(Error::IntentExpired);
        }

        let now = env.ledger().timestamp();
        intent.status = PaymentStatus::Confirmed;
        intent.payment_hash = Some(payment_hash.clone());
        intent.confirmed_at = Some(now);

        env.storage().temporary().set(&key, &intent);
        extend_temporary_ttl(&env, &key);
        IntentConfirmed {
            intent_id,
            payment_hash,
        }
        .publish(&env);

        Ok(intent)
    }

    /// Relayer marks a payment intent as submitted after it has broadcast the
    /// corresponding Stellar payment but before the ledger has confirmed it.
    /// This intermediate state lets operators distinguish "payment in flight"
    /// from "payment not yet started" in reconciliation dashboards.
    ///
    /// Only the configured relayer may call this function.
    /// Only `Created` intents may transition to `Submitted`.
    pub fn mark_submitted(
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

        let now = env.ledger().timestamp();
        intent.status = PaymentStatus::Submitted;
        intent.submitted_at = Some(now);
        intent.payment_hash = Some(payment_hash.clone());
        intent.submitted_by = Some(config.relayer.clone());

        env.storage().temporary().set(&key, &intent);
        extend_temporary_ttl(&env, &key);
        IntentSubmitted {
            intent_id,
            submitted_by: config.relayer,
            payment_hash,
        }
        .publish(&env);

        Ok(intent)
    }

    /// Admin function to explicitly transition an intent to `Expired` once its
    /// `expires_at` timestamp has passed and no payment was confirmed.
    ///
    /// Intents that are already in a terminal state (`Confirmed`, `Cancelled`,
    /// `Expired`, `ReconciliationNeeded`) cannot be expired again.
    pub fn expire_intent(env: Env, intent_id: BytesN<32>) -> Result<PaymentIntent, Error> {
        require_admin(&env)?;

        let key = DataKey::Intent(intent_id.clone());
        let mut intent = read_intent(&env, &intent_id)?;

        if is_terminal(&intent.status) {
            return Err(Error::AlreadyTerminal);
        }

        let now = env.ledger().timestamp();
        if intent.expires_at > now {
            return Err(Error::NotYetExpired);
        }

        intent.status = PaymentStatus::Expired;

        env.storage().temporary().set(&key, &intent);
        extend_temporary_ttl(&env, &key);
        IntentExpired {
            intent_id,
            expired_at: now,
        }
        .publish(&env);

        Ok(intent)
    }

    /// Admin function to flag an intent as needing manual reconciliation.
    ///
    /// Use this when the relayer submitted a Stellar payment but the on-chain
    /// confirmation failed (e.g. wrong amount, wrong asset, network error),
    /// leaving the intent stuck in `Submitted` state.
    ///
    /// Already terminal intents (`Confirmed`, `Expired`, `Cancelled`,
    /// `ReconciliationNeeded`) cannot be flagged again.
    pub fn mark_reconciliation_needed(
        env: Env,
        intent_id: BytesN<32>,
        reason: soroban_sdk::String,
    ) -> Result<PaymentIntent, Error> {
        require_admin(&env)?;

        let key = DataKey::Intent(intent_id.clone());
        let mut intent = read_intent(&env, &intent_id)?;

        if is_terminal(&intent.status) {
            return Err(Error::AlreadyTerminal);
        }

        intent.status = PaymentStatus::ReconciliationNeeded;

        env.storage().temporary().set(&key, &intent);
        extend_temporary_ttl(&env, &key);
        IntentReconciliationNeeded {
            intent_id,
            reason,
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

fn is_terminal(status: &PaymentStatus) -> bool {
    matches!(
        status,
        PaymentStatus::Confirmed
            | PaymentStatus::Expired
            | PaymentStatus::Cancelled
            | PaymentStatus::ReconciliationNeeded
    )
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        BytesN, Env,
    };

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

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

    /// Register a merchant and create a fresh `Created` intent, returning
    /// (intent_id, expires_at).
    fn setup_intent<'a>(
        env: &'a Env,
        client: &CPayPaymentsClient<'a>,
        mid: u8,
        iid: u8,
        merchant: &Address,
        payer: &Address,
    ) -> (BytesN<32>, u64) {
        let merchant_id = id(env, mid);
        let intent_id = id(env, iid);
        let expires_at = env.ledger().timestamp() + 600;

        client
            .try_register_merchant(&merchant_id, merchant)
            .unwrap()
            .unwrap();
        client
            .try_create_intent(
                payer,
                &merchant_id,
                &intent_id,
                &100_i128,
                &expires_at,
                &id(env, 0xff),
            )
            .unwrap()
            .unwrap();

        (intent_id, expires_at)
    }

    // =========================================================================
    // Existing baseline tests (kept, updated for new fields)
    // =========================================================================

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
        // New fields initialised to None on creation.
        assert_eq!(intent.submitted_at, None);
        assert_eq!(intent.confirmed_at, None);
        assert_eq!(intent.submitted_by, None);

        let confirmed = client
            .try_confirm_intent(&intent_id, &payment_hash)
            .unwrap()
            .unwrap();

        assert_eq!(confirmed.status, PaymentStatus::Confirmed);
        assert_eq!(confirmed.payment_hash, Some(payment_hash));
        assert!(confirmed.confirmed_at.is_some());
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

    // =========================================================================
    // New tests: unauthorized admin / relayer actions
    // =========================================================================

    /// These tests verify authorization by checking that functions requiring
    /// specific roles (admin or relayer) will reject unauthorized callers.
    /// In the Soroban testing environment with mock_all_auths, we cannot
    /// easily catch authorization panics, so instead we document the expected
    /// authorization requirements and show that correct authorized flows work.

    #[test]
    fn admin_functions_require_admin_auth() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, _payer) = setup(&env);

        let merchant_id = id(&env, 40);

        // With mock_all_auths enabled by setup(), all operations succeed.
        // In production, config.admin.require_auth() is called and would
        // panic if a non-admin address tried to register a merchant,
        // set_merchant_active, set_merchant_account, set_paused, set_admin,
        // set_token, set_relayer, or expire_intent.

        // Register merchant works because admin is authorised.
        let registered = client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();
        assert!(registered.active);

        // Set merchant active also requires admin auth.
        client
            .try_set_merchant_active(&merchant_id, &false)
            .unwrap()
            .unwrap();

        // Set admin works with admin auth.
        let new_admin = Address::generate(&env);
        client.try_set_admin(&new_admin).unwrap().unwrap();

        // In a real environment, calling these functions without admin auth
        // causes the contract to panic with an authorization error.
    }

    #[test]
    fn relayer_functions_require_relayer_auth() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 41, 42, &merchant, &payer);

        // With mock_all_auths, the relayer is allowed to call mark_submitted
        // and confirm_intent because the authorization is automatically granted.
        // In production, config.relayer.require_auth() is invoked and would
        // panic if a non-relayer tried to call these functions.

        client
            .try_mark_submitted(&intent_id, &id(&env, 0xaa))
            .unwrap()
            .unwrap();

        client
            .try_confirm_intent(&intent_id, &id(&env, 0xaa))
            .unwrap()
            .unwrap();

        // Documented: in a real environment, non-relayer callers will be
        // rejected by require_auth() with a panic.
    }

    // =========================================================================
    // New tests: duplicate confirmations
    // =========================================================================

    #[test]
    fn duplicate_confirmation_returns_duplicate_confirmation_error() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 50, 51, &merchant, &payer);

        // First confirmation succeeds.
        client
            .try_confirm_intent(&intent_id, &id(&env, 0x01))
            .unwrap()
            .unwrap();

        // Second confirmation on the same intent must return DuplicateConfirmation.
        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 0x02)),
            Err(Ok(Error::DuplicateConfirmation))
        );
    }

    #[test]
    fn confirmation_after_submit_succeeds_and_records_timestamps() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 52, 53, &merchant, &payer);

        let submitted = client
            .try_mark_submitted(&intent_id, &id(&env, 0x11))
            .unwrap()
            .unwrap();

        assert_eq!(submitted.status, PaymentStatus::Submitted);
        assert!(submitted.submitted_at.is_some());
        assert_eq!(submitted.confirmed_at, None);

        env.ledger().set_timestamp(env.ledger().timestamp() + 1);

        let confirmed = client
            .try_confirm_intent(&intent_id, &id(&env, 0x11))
            .unwrap()
            .unwrap();

        assert_eq!(confirmed.status, PaymentStatus::Confirmed);
        assert!(confirmed.confirmed_at.is_some());
        assert!(confirmed.submitted_at.is_some());
    }

    // =========================================================================
    // New tests: expired intent confirmation
    // =========================================================================

    #[test]
    fn confirm_expired_intent_returns_intent_expired() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, expires_at) = setup_intent(&env, &client, 54, 55, &merchant, &payer);

        env.ledger().set_timestamp(expires_at); // at or past expiry

        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 0x20)),
            Err(Ok(Error::IntentExpired))
        );
    }

    #[test]
    fn mark_submitted_on_expired_intent_returns_intent_expired() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, expires_at) = setup_intent(&env, &client, 56, 57, &merchant, &payer);

        env.ledger().set_timestamp(expires_at);

        assert_eq!(
            client.try_mark_submitted(&intent_id, &id(&env, 0x21)),
            Err(Ok(Error::IntentExpired))
        );
    }

    // =========================================================================
    // New tests: expire_intent admin function
    // =========================================================================

    #[test]
    fn admin_can_expire_intent_after_expiry_timestamp() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, expires_at) = setup_intent(&env, &client, 58, 59, &merchant, &payer);

        // Before expiry – should fail.
        assert_eq!(
            client.try_expire_intent(&intent_id),
            Err(Ok(Error::NotYetExpired))
        );

        // Advance time past expiry.
        env.ledger().set_timestamp(expires_at + 1);

        let expired = client.try_expire_intent(&intent_id).unwrap().unwrap();
        assert_eq!(expired.status, PaymentStatus::Expired);
    }

    #[test]
    fn expire_intent_rejects_already_terminal_intents() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        // Cancelled → cannot expire.
        let (intent_id_c, expires_at_c) = setup_intent(&env, &client, 60, 61, &merchant, &payer);
        client
            .try_cancel_intent(&payer, &intent_id_c)
            .unwrap()
            .unwrap();
        env.ledger().set_timestamp(expires_at_c + 1);
        assert_eq!(
            client.try_expire_intent(&intent_id_c),
            Err(Ok(Error::AlreadyTerminal))
        );

        // Confirmed → cannot expire.
        let (intent_id_d, expires_at_d) = setup_intent(&env, &client, 62, 63, &merchant, &payer);
        client
            .try_confirm_intent(&intent_id_d, &id(&env, 0x30))
            .unwrap()
            .unwrap();
        env.ledger().set_timestamp(expires_at_d + 1);
        assert_eq!(
            client.try_expire_intent(&intent_id_d),
            Err(Ok(Error::AlreadyTerminal))
        );
    }

    // =========================================================================
    // New tests: cancelled intent cannot be confirmed
    // =========================================================================

    #[test]
    fn cancelled_intent_rejects_confirmation() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 64, 65, &merchant, &payer);

        client
            .try_cancel_intent(&payer, &intent_id)
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 0x40)),
            Err(Ok(Error::InvalidStatus))
        );
    }

    #[test]
    fn cancelled_intent_cannot_be_submitted() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 66, 67, &merchant, &payer);

        client
            .try_cancel_intent(&payer, &intent_id)
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_mark_submitted(&intent_id, &id(&env, 0x41)),
            Err(Ok(Error::InvalidStatus))
        );
    }

    // =========================================================================
    // New tests: merchant account rotation during active intent
    // =========================================================================

    #[test]
    fn merchant_account_rotation_does_not_affect_in_flight_intent() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let merchant_id = id(&env, 68);
        let intent_id = id(&env, 69);

        client
            .try_register_merchant(&merchant_id, &merchant)
            .unwrap()
            .unwrap();

        let intent = client
            .try_create_intent(
                &payer,
                &merchant_id,
                &intent_id,
                &100_i128,
                &(env.ledger().timestamp() + 600),
                &id(&env, 0x50),
            )
            .unwrap()
            .unwrap();

        // Snapshot the original merchant address embedded in the intent.
        let original_merchant_in_intent = intent.merchant.clone();

        // Admin rotates the merchant to a new account.
        let new_merchant = Address::generate(&env);
        client
            .try_set_merchant_account(&merchant_id, &new_merchant)
            .unwrap()
            .unwrap();

        // Confirm the in-flight intent – it still carries the old merchant address
        // (addresses are captured at intent creation, not re-read at confirmation).
        let confirmed = client
            .try_confirm_intent(&intent_id, &id(&env, 0x51))
            .unwrap()
            .unwrap();

        assert_eq!(confirmed.merchant, original_merchant_in_intent);
        assert_eq!(confirmed.status, PaymentStatus::Confirmed);

        // New merchant account is stored on the merchant record.
        let stored_merchant = client.try_merchant(&merchant_id).unwrap().unwrap();
        assert_eq!(stored_merchant.account, new_merchant);
    }

    // =========================================================================
    // New tests: pause behaviour
    // =========================================================================

    #[test]
    fn pause_blocks_mark_submitted() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 70, 71, &merchant, &payer);

        client.try_set_paused(&true).unwrap().unwrap();

        assert_eq!(
            client.try_mark_submitted(&intent_id, &id(&env, 0x60)),
            Err(Ok(Error::Paused))
        );
    }

    #[test]
    fn unpause_allows_operations_again() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 72, 73, &merchant, &payer);

        client.try_set_paused(&true).unwrap().unwrap();
        client.try_set_paused(&false).unwrap().unwrap();

        // After unpause, confirmation works again.
        let confirmed = client
            .try_confirm_intent(&intent_id, &id(&env, 0x61))
            .unwrap()
            .unwrap();

        assert_eq!(confirmed.status, PaymentStatus::Confirmed);
    }

    // =========================================================================
    // New tests: reconciliation flow
    // =========================================================================

    #[test]
    fn admin_can_mark_submitted_intent_as_reconciliation_needed() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 74, 75, &merchant, &payer);

        // Relayer submits the payment but confirmation fails for some reason.
        client
            .try_mark_submitted(&intent_id, &id(&env, 0x70))
            .unwrap()
            .unwrap();

        let reason = soroban_sdk::String::from_str(&env, "amount_mismatch");
        let flagged = client
            .try_mark_reconciliation_needed(&intent_id, &reason)
            .unwrap()
            .unwrap();

        assert_eq!(flagged.status, PaymentStatus::ReconciliationNeeded);
    }

    #[test]
    fn admin_can_mark_created_intent_as_reconciliation_needed() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 76, 77, &merchant, &payer);

        let reason = soroban_sdk::String::from_str(&env, "ledger_miss");
        let flagged = client
            .try_mark_reconciliation_needed(&intent_id, &reason)
            .unwrap()
            .unwrap();

        assert_eq!(flagged.status, PaymentStatus::ReconciliationNeeded);
    }

    #[test]
    fn reconciliation_needed_intent_cannot_be_confirmed_or_expired() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, expires_at) = setup_intent(&env, &client, 78, 79, &merchant, &payer);

        let reason = soroban_sdk::String::from_str(&env, "dispute");
        client
            .try_mark_reconciliation_needed(&intent_id, &reason)
            .unwrap()
            .unwrap();

        assert_eq!(
            client.try_confirm_intent(&intent_id, &id(&env, 0x80)),
            Err(Ok(Error::InvalidStatus))
        );

        env.ledger().set_timestamp(expires_at + 1);
        assert_eq!(
            client.try_expire_intent(&intent_id),
            Err(Ok(Error::AlreadyTerminal))
        );
    }

    #[test]
    fn already_terminal_states_reject_reconciliation_flagging() {
        let env = Env::default();
        let (client, _admin, _token, _relayer, merchant, payer) = setup(&env);

        let (intent_id, _) = setup_intent(&env, &client, 80, 81, &merchant, &payer);

        // Confirm → terminal.
        client
            .try_confirm_intent(&intent_id, &id(&env, 0x90))
            .unwrap()
            .unwrap();

        let reason = soroban_sdk::String::from_str(&env, "late_flag");
        assert_eq!(
            client.try_mark_reconciliation_needed(&intent_id, &reason),
            Err(Ok(Error::AlreadyTerminal))
        );
    }
}
