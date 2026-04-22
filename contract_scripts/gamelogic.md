1. The Core Setup

    Players: 1v1 (Red Agent vs. Blue Agent).

    Health: Both players start with 10 HP.

    Goal: Be mathematically closer to 21 than your opponent at the end of the round. You can go over 21, but a score of 22 will lose to a score of 20 (since 20 is closer).

    The Deck: Infinite standard deck mechanics.

        Cards 2-10 are face value.

        Jack, Queen, King are always worth 10.

        Smart Aces: An Ace is worth 11. However, if a player's score busts over 21, the contract automatically downgrades the Ace to a 1 to save them.

2. The Game Loop (Phase by Phase)

The smart contract operates via a strict state machine. The frontend UI should update based on the GamePhase variable in the GameState PDA.

Phase 1: AwaitingInitialDeal

    The backend crank requests the first Switchboard VRF.

    The oracle deals exactly 1 card to Red and 1 card to Blue.

    The UI should render these first two cards face up.

Phase 2: AwaitingHitVRF & AwaitingAction (The Turn Loop)

    Red goes first. The active agent evaluates their hand and chooses to either Hit (request VRF) or Stay.

    Forced Stays: If an agent hits and their score goes to 21 or over, they cannot hit again. The contract forces their stayed boolean to true and passes the turn.

    Once Red stays, Blue gets to hit or stay.

    Once both agents have stayed, the game moves to Phase 3.

Phase 3: AwaitingFinalRevealVRF (The River Card)

    Both players have locked in their hands.

    The backend crank requests the Final Reveal VRF.

    The oracle deals exactly 1 final card to Red and 1 final card to Blue simultaneously.

    Frontend Note: This is the most hype moment of the round. The UI should dramatically reveal these final cards, as they can completely flip a guaranteed win into a bust.

Phase 4: ReadyToResolve (Damage Calculation)

    The backend crank calls resolve_round. The contract calculates who is closer to 21 (abs_diff(21)).

    Damage Scaling: Damage doubles every round.

        Round 1 = 1 Damage

        Round 2 = 2 Damage

        Round 3 = 4 Damage

        Round 4 = 8 Damage

    The loser subtracts the damage from their HP.

Phase 5: AwaitingTiebreakerVRF (Sudden Death)

    If both players are exactly the same distance from 21 (e.g., both have 18, or both busted to 24), nobody takes damage yet.

    The game enters Sudden Death. The crank requests another VRF, dealing 1 more card to both players.

    The contract recalculates. They keep drawing cards until someone is mathematically closer to 21.

Phase 6: Ended

    The moment a player hits 0 HP, the game is over.

    The contract automatically resolves the LMSR prediction markets and payouts are unlocked for the bettors.
