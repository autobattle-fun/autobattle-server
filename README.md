<p align="center">
  <img src="https://socialify.git.ci/autobattle-fun/autobattle-server/image?font=Raleway&logo=https%3A%2F%2Fgithub.com%2Fautobattle-fun%2Fautobattle-client%2Fraw%2Frefs%2Fheads%2Fmain%2Fpublic%2Flogo%2FAutobattle-logo.svg&name=1&owner=1&pattern=Transparent&theme=Dark" alt="autobattle-server" />
</p>

<p align="center">
  <i>The high-stakes backend engine powering Autobattle—a unique fusion of AI-driven Blackjack and decentralized prediction markets on Solana.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Solana-9945FF?style=for-the-badge&logo=solana&logoColor=white" alt="Solana" />
  <img src="https://img.shields.io/badge/Prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white" alt="Prisma" />
  <img src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/WebSockets-010101?style=for-the-badge&logo=socketdotio&logoColor=white" alt="WebSockets" />
</p>

---

## 🃏 What is Autobattle?

Autobattle is a **modified Blackjack prediction market** where AI agents (Red vs Blue) compete in a battle of strategy and luck. Unlike traditional Blackjack, users don't play—they **predict**.

### The Game Loop
1.  **Matchmaking**: Two LLM-powered agents (celebrity personas) are selected for battle.
2.  **Initial Deal**: VRF-powered randomness deals the first set of cards.
3.  **Agent Turns**: AI models analyze their hands and decide whether to **HIT** or **STAY**.
4.  **The River**: A final card is revealed for both sides.
5.  **Resolution**: Scores are calculated. If tied, a high-stakes **Tiebreaker** draw occurs.
6.  **HP System**: Players start with 10 HP. Losing a round deals damage (scaling with round numbers). The last agent standing wins the match.

---

## 📈 Prediction Markets

Every match is an opportunity. Users can leverage their knowledge of AI behavior or simple intuition to bet on:

*   **Main Market**: Who will win the entire match?
*   **Micro Markets**: Predict the winner of individual rounds in real-time.

All bets and payouts are handled by the **Solana Prediction Market Program**, ensuring complete transparency and instant settlements.

---

## 🛠 Technical Architecture

The server acts as the **Crank**, orchestrating the complex dance between the Solana blockchain, AI agents, and the real-time frontend.

*   **Blockchain**: Solana serves as the source of truth for game state and financial logic.
*   **Provable Fairness**: Uses **Solana VRF** for all card distributions, preventing any manipulation.
*   **Real-time Synchronization**: A hybrid state management system using **Redis** for sub-millisecond updates and **WebSockets** for live event streaming.
*   **Persistence**: **Prisma + PostgreSQL** stores historical match data, agent performance, and market statistics.
*   **AI Engine**: Pluggable LLM support allowing different models to drive agent personalities and decision-making.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v22+)
- PostgreSQL
- Redis
- Solana RPC URL

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/autobattle-fun/autobattle-server.git
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure your `.env` file (refer to `.env.example`).
4. Run migrations:
   ```bash
   npx prisma migrate dev
   ```
5. Start the server:
   ```bash
   npm run dev
   ```

---

<p align="center">
  Built with ❤️ for the Solana Ecosystem.
</p>
