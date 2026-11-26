use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("math overflow")]
    Math,
    #[msg("the program is paused; withdrawals still work")]
    Paused,
    #[msg("amount must be more than zero")]
    ZeroAmount,
    #[msg("this would put you over the per-user beta cap")]
    UserCap,
    #[msg("the beta is full; the total cap has been reached")]
    TotalCap,
    #[msg("caps cannot go above the hard beta limits")]
    CapTooHigh,
    #[msg("the dollar token must have 6 decimals")]
    BadDecimals,
    #[msg("the mix must be between 0 and 10000 basis points")]
    BadMix,
    #[msg("rule amount is out of range")]
    BadRule,
    #[msg("the weekly buy is not due yet")]
    NotDue,
    #[msg("nothing to buy this week")]
    NothingToBuy,
    #[msg("the price floor must be more than zero")]
    BadFloor,
    #[msg("the swap took a different amount than the rule allows")]
    SwapTookWrongAmount,
    #[msg("the swap returned less than the floor")]
    SwapPaidTooLittle,
    #[msg("a swap account is one of the vault's own accounts")]
    SwapAccountClash,
    #[msg("only the admin can do this")]
    NotAdmin,
    #[msg("only the pending admin can accept")]
    NotPendingAdmin,
    #[msg("only the program's upgrade authority can set it up")]
    NotUpgradeAuthority,
    #[msg("not enough tokens in the vault")]
    Insufficient,
    #[msg("this vault has a hash-based key; withdrawals need its signature")]
    PqRequired,
    #[msg("a hash-based key is already enrolled; replace it with rotate_pq")]
    PqAlreadyEnrolled,
    #[msg("no hash-based key is enrolled on this vault")]
    PqNotEnrolled,
    #[msg("the tree height must be between 1 and 16 and the root must not be zero")]
    BadPqKey,
    #[msg("that one-time key number is already used up or out of range")]
    PqLeafUsed,
    #[msg("the hash-based signature does not match")]
    BadPqSignature,
    #[msg("the destination holds a different token")]
    WrongMint,
    #[msg("that is not Jupiter Lend's market for our dollar token")]
    WrongVenue,
    #[msg("the lending venue moved a different amount than asked")]
    VenueMisbehaved,
    #[msg("that is not this vault's own lending share account")]
    WrongShareAccount,
    #[msg("the price account is not a fully verified Pyth update for the venue's feed")]
    BadPrice,
    #[msg("the price is too old")]
    StalePrice,
    #[msg("the price's confidence band is too wide")]
    UnsurePrice,
    #[msg("this week's buy needs savings that are still lent; run prepare_buy first")]
    SavingsStillLent,
    #[msg("venue bounds are past the hard limits")]
    BadVenueBounds,
    #[msg("Kashu's cut can never be above 10%")]
    CutTooHigh,
    #[msg("that is not a room made by the rooms program")]
    NotARoom,
    #[msg("this vault feeds a different room's pot")]
    WrongPot,
    #[msg("the treasury must be the admin's own dollar account")]
    WrongTreasury,
    #[msg("there is less than a cent of interest to harvest")]
    NothingToHarvest,
    #[msg("a harvest may only take interest, never savings")]
    HarvestTouchedSavings,
    #[msg("the room's draw is not settled yet")]
    DrawNotSettled,
    #[msg("this week's prize is already paid")]
    PrizeAlreadyPaid,
    #[msg("that vault does not belong to the draw's winner")]
    NotTheWinner,
    #[msg("That account isn't held by the private pocket this wallet named")]
    NotYourPocket,
    #[msg("That chore isn't one the saver set up")]
    BadChore,
    #[msg("Only the saver's agent can run their chores")]
    NotTheAgent,
    #[msg("That chore already ran this week")]
    ChoreTooSoon,
    #[msg("That would go over the weekly limit the saver set for their agent")]
    AgentCap,
    #[msg("A chore can only send money to the saver's own vault, their pocket, or someone they named")]
    AgentDestination,
}
