import WebSocket, { WebSocketServer } from "ws";
import prisma from "./db";
import { logger } from "./utils/logger";
import type { $Enums } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

// Configuration Constants
const CONFIG = {
  PORT: Number(process.env.PORT) || 8080,
  CLEANUP_INTERVAL_MS: 60000, // 1 minute
  STALE_CHALLENGE_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  CHALLENGE_EXPIRY_MS: 24 * 60 * 60 * 1000, // 24 hours
  MAX_CONNECTIONS: 10000,
} as const;

// Type Definitions
interface OnlineUserData {
  ws: WebSocket;
  name: string;
  connectedAt: number;
}

interface ChallengeStartState {
  creatorStarted: boolean;
  opponentStarted: boolean;
  timestamp: number;
}

interface MessagePayload {
  type: string;
  [key: string]: any;
}

// In-Memory State Management
class StateManager {
  private onlineUsers = new Map<string, OnlineUserData>();
  private startChallengeMap = new Map<string, ChallengeStartState>();
  private winnerSelections = new Map<string, Map<string, string>>();

  // Online Users
  setUserOnline(userId: string, ws: WebSocket, name: string): void {
    this.onlineUsers.set(userId, { ws, name, connectedAt: Date.now() });
  }

  getUserData(userId: string): OnlineUserData | undefined {
    return this.onlineUsers.get(userId);
  }

  removeUser(userId: string): boolean {
    return this.onlineUsers.delete(userId);
  }

  getAllOnlineUsers(): Array<{ id: string; name: string }> {
    return Array.from(this.onlineUsers.entries()).map(([userId, data]) => ({
      id: userId,
      name: data.name,
    }));
  }

  isUserOnline(userId: string): boolean {
    return this.onlineUsers.has(userId);
  }

  forEachUser(callback: (data: OnlineUserData, userId: string) => void): void {
    this.onlineUsers.forEach(callback);
  }

  findUserByWebSocket(ws: WebSocket): [string, OnlineUserData] | undefined {
    for (const [userId, data] of this.onlineUsers.entries()) {
      if (data.ws === ws) return [userId, data];
    }
    return undefined;
  }

  // Challenge Start State
  getChallengeState(challengeId: string): ChallengeStartState | undefined {
    return this.startChallengeMap.get(challengeId);
  }

  initializeChallengeState(challengeId: string): ChallengeStartState {
    const state: ChallengeStartState = {
      creatorStarted: false,
      opponentStarted: false,
      timestamp: Date.now(),
    };
    this.startChallengeMap.set(challengeId, state);
    return state;
  }

  deleteChallengeState(challengeId: string): boolean {
    return this.startChallengeMap.delete(challengeId);
  }

  cleanupStaleChallenges(timeoutMs: number): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [challengeId, data] of this.startChallengeMap.entries()) {
      if (now - data.timestamp > timeoutMs) {
        this.startChallengeMap.delete(challengeId);
        cleanedCount++;
        logger.info(
          `Cleaned up stale start attempt for challenge ${challengeId}`
        );
      }
    }

    return cleanedCount;
  }

  // Winner Selections
  getWinnerSelections(challengeId: string): Map<string, string> | undefined {
    return this.winnerSelections.get(challengeId);
  }

  setWinnerSelection(
    challengeId: string,
    playerId: string,
    winnerId: string
  ): void {
    if (!this.winnerSelections.has(challengeId)) {
      this.winnerSelections.set(challengeId, new Map());
    }
    this.winnerSelections.get(challengeId)!.set(playerId, winnerId);
  }

  deleteWinnerSelections(challengeId: string): boolean {
    return this.winnerSelections.delete(challengeId);
  }

  getAllWinnerSelections(): Map<string, Map<string, string>> {
    return this.winnerSelections;
  }
}

const state = new StateManager();
const wss = new WebSocketServer({
  port: CONFIG.PORT,
  maxPayload: 100 * 1024, // 100KB max message size
});

// Periodic Cleanup Tasks
const cleanupInterval = setInterval(() => {
  const cleaned = state.cleanupStaleChallenges(
    CONFIG.STALE_CHALLENGE_TIMEOUT_MS
  );
  if (cleaned > 0) {
    logger.info(`Cleanup: Removed ${cleaned} stale challenge start attempts`);
  }
}, CONFIG.CLEANUP_INTERVAL_MS);

// Load winner selections from database on startup
async function loadWinnerSelectionsFromDB(): Promise<void> {
  try {
    const selections = await prisma.winnerSelection.findMany({
      where: {
        Challenge: {
          status: "IN_PROGRESS", // Only fetch active challenges
        },
      },
      select: {
        challengeId: true,
        playerId: true,
        selectedWinner: true,
        Challenge: {
          select: { status: true },
        },
      },
    });

    let loadedCount = 0;
    selections.forEach((selection) => {
      state.setWinnerSelection(
        selection.challengeId,
        selection.playerId,
        selection.selectedWinner
      );
      loadedCount++;
    });

    logger.info(
      `Successfully loaded ${loadedCount} winner selections for IN_PROGRESS challenges`
    );
  } catch (error) {
    logger.error(`Failed to load winner selections from database:`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // Re-throw to prevent server from starting with bad state
  }
}

// Helper function to enrich challenge data with winner selections
function enrichChallengeWithSelections<T extends { id: string }>(
  challenge: T
): T & { winnerSelections: Record<string, string> } {
  const selections = state.getWinnerSelections(challenge.id);
  const selectionsObj: Record<string, string> = {};

  if (selections) {
    selections.forEach((winner, player) => {
      selectionsObj[player] = winner;
    });
  }

  return {
    ...challenge,
    winnerSelections: selectionsObj,
  };
}

// Broadcast Functions
function broadcastOnlineUsers(): void {
  const onlineUsersList = state.getAllOnlineUsers();
  const message = JSON.stringify({
    type: "onlineUsers",
    users: onlineUsersList,
  });

  state.forEachUser((data) => {
    if (data.ws.readyState === WebSocket.OPEN) {
      try {
        data.ws.send(message);
      } catch (error) {
        logger.error(`Failed to send online users to client:`, error);
      }
    }
  });
}

function broadcastToChallengePlayers(
  creatorId: string,
  inviteeId: string | null,
  message: MessagePayload
): void {
  const players = [creatorId, inviteeId].filter(
    (id): id is string => id !== null
  );
  const messageStr = JSON.stringify(message);

  players.forEach((playerId) => {
    const playerData = state.getUserData(playerId);
    if (playerData?.ws.readyState === WebSocket.OPEN) {
      try {
        playerData.ws.send(messageStr);
      } catch (error) {
        logger.error(`Failed to broadcast to player ${playerId}:`, error);
      }
    }
  });
}

// Type for Challenge Data
type ChallengeData = {
  id: string;
  creatorId: string;
  inviteeId: string | null;
  status: $Enums.ChallengeStatus;
  game: string;
  description: string | null;
  coins: number;
  xp: number;
  rules: JsonValue;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  expiresAt: Date;
  completedAt: Date | null;
  winnerId: string | null;
  claimTime: Date | null;
};

function broadcastChallengeUpdate(updatedChallenge: ChallengeData): void {
  const enrichedChallenge = enrichChallengeWithSelections(updatedChallenge);
  const message: MessagePayload = {
    type: "challengeAccepted",
    updatedChallenge: enrichedChallenge,
  };

  broadcastToChallengePlayers(
    updatedChallenge.creatorId,
    updatedChallenge.inviteeId,
    message
  );
}

function broadcastGameStateUpdate(updateState: ChallengeData): void {
  const enrichedState = enrichChallengeWithSelections(updateState);
  const message: MessagePayload = {
    type: "challengeStartedBy",
    updateState: enrichedState,
  };

  broadcastToChallengePlayers(
    updateState.creatorId,
    updateState.inviteeId,
    message
  );
}

function broadcastNewChallenge(newChallenge: ChallengeData): void {
  const message: MessagePayload = {
    type: "challengeCreated",
    newChallenge,
  };

  broadcastToChallengePlayers(
    newChallenge.creatorId,
    newChallenge.inviteeId,
    message
  );
}

function broadcastOpenChallenge(newChallenge: ChallengeData): void {
  const message = JSON.stringify({
    type: "openChallengeCreated",
    newChallenge,
  });

  state.forEachUser((data) => {
    if (data.ws.readyState === WebSocket.OPEN) {
      try {
        data.ws.send(message);
      } catch (error) {
        logger.error("Failed to broadcast open challenge:", error);
      }
    }
  });
}

wss.on("connection", (ws: WebSocket) => {
  const connectionId = `conn_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  ws.on("error", (error) => {
    logger.error(`WebSocket error for ${connectionId}:`, error);
  });

  ws.on("message", async (message: string) => {
    try {
      const userInfo: MessagePayload = JSON.parse(message);

      // Route to appropriate handler based on message type
      switch (userInfo.type) {
        case "setOnline":
          await handleSetOnline(ws, userInfo);
          break;
        case "selectWinner":
          await handleSelectWinner(ws, userInfo);
          break;
        case "getWinnerSelections":
          await handleGetWinnerSelections(ws, userInfo);
          break;
        case "createChallenge":
          await handleCreateChallenge(userInfo);
          break;
        case "acceptChallenge":
          await handleAcceptChallenge(userInfo);
          break;
        case "joinOpenChallenge":
          await handleJoinOpenChallenge(ws, userInfo);
          break;
        case "startChallenge":
          await handleStartChallenge(ws, userInfo);
          break;
        case "claimVictory":
          await handleClaimVictory(ws, userInfo);
          break;
        default:
          logger.warn(`Unknown message type: ${userInfo.type}`);
      }
    } catch (error) {
      logger.error(`Error processing message:`, {
        error: error instanceof Error ? error.message : String(error),
        connectionId,
      });

      try {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Failed to process message",
          })
        );
      } catch (sendError) {
        logger.error("Failed to send error message:", sendError);
      }
    }
  });

  ws.on("close", () => {
    const userEntry = state.findUserByWebSocket(ws);
    if (userEntry) {
      const [userId, data] = userEntry;
      state.removeUser(userId);
      broadcastOnlineUsers();
    }
  });
});

// Message Handlers
async function handleSetOnline(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { userId, online } = userInfo;

  if (!userId) {
    logger.warn("setOnline called without userId");
    return;
  }

  const userExists = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });

  if (online && userExists) {
    state.setUserOnline(userId, ws, userExists.name);
    broadcastOnlineUsers();
  } else if (!userExists) {
    logger.warn(`User ${userId} does not exist in the database`);
  }
}

async function handleSelectWinner(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { gameId, playerId, selectedWinner } = userInfo;

  // Validation
  if (!gameId || !playerId || !selectedWinner) {
    logger.warn("selectWinner called with missing parameters", {
      gameId,
      playerId,
      selectedWinner,
    });
    return;
  }

  try {
    // Use transaction for atomicity
    const [, challenge] = await prisma.$transaction(async (tx) => {
      // Upsert winner selection
      const selection = await tx.winnerSelection.upsert({
        where: {
          challengeId_playerId: {
            challengeId: gameId,
            playerId: playerId,
          },
        },
        create: {
          challengeId: gameId,
          playerId: playerId,
          selectedWinner: selectedWinner,
        },
        update: {
          selectedWinner: selectedWinner,
          updatedAt: new Date(),
        },
      });

      // Fetch challenge data
      const challengeData = await tx.challenge.findUnique({
        where: { id: gameId },
      });

      return [selection, challengeData];
    });

    if (!challenge) {
      logger.error(`Challenge not found: ${gameId}`);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Challenge not found",
        })
      );
      return;
    }

    // Update in-memory cache
    state.setWinnerSelection(gameId, playerId, selectedWinner);

    // Enrich and broadcast
    const enrichedChallenge = enrichChallengeWithSelections(challenge);

    broadcastToChallengePlayers(challenge.creatorId, challenge.inviteeId, {
      type: "challengeUpdate",
      challenge: enrichedChallenge,
    });
  } catch (error) {
    logger.error(`Failed to save winner selection:`, {
      error: error instanceof Error ? error.message : String(error),
      gameId,
      playerId,
    });

    try {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to save winner selection",
        })
      );
    } catch (sendError) {
      logger.error("Failed to send error response:", sendError);
    }
  }
}

async function handleGetWinnerSelections(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  try {
    // Optimized query - only fetch IN_PROGRESS challenges
    const dbSelections = await prisma.winnerSelection.findMany({
      where: {
        Challenge: {
          status: "IN_PROGRESS",
        },
      },
      select: {
        challengeId: true,
        playerId: true,
        selectedWinner: true,
      },
    });

    // Build response object
    const allSelections: Record<string, Record<string, string>> = {};

    dbSelections.forEach((selection) => {
      if (!allSelections[selection.challengeId]) {
        allSelections[selection.challengeId] = {};
      }
      allSelections[selection.challengeId][selection.playerId] =
        selection.selectedWinner;

      // Update memory cache
      state.setWinnerSelection(
        selection.challengeId,
        selection.playerId,
        selection.selectedWinner
      );
    });

    ws.send(
      JSON.stringify({
        type: "allWinnerSelections",
        selections: allSelections,
      })
    );
  } catch (error) {
    logger.error(`Failed to load winner selections:`, error);

    // Fallback to memory cache
    const allSelections: Record<string, Record<string, string>> = {};
    const cachedSelections = state.getAllWinnerSelections();

    cachedSelections.forEach((gameSelections, gameId) => {
      const selectionsObj: Record<string, string> = {};
      gameSelections.forEach((winner, player) => {
        selectionsObj[player] = winner;
      });
      allSelections[gameId] = selectionsObj;
    });

    try {
      ws.send(
        JSON.stringify({
          type: "allWinnerSelections",
          selections: allSelections,
        })
      );
    } catch (sendError) {
      logger.error("Failed to send fallback selections:", sendError);
    }
  }
}

async function handleCreateChallenge(userInfo: MessagePayload): Promise<void> {
  const {
    creatorId,
    coins,
    xp,
    inviteeId,
    game,
    description,
    rules,
    isOpen = false,
  } = userInfo;

  // Validation
  if (!creatorId || !game || coins === undefined) {
    logger.warn("createChallenge called with missing parameters");
    return;
  }

  const targetInvitee = isOpen ? null : inviteeId || null;
  const challengeStatus: $Enums.ChallengeStatus = "PENDING";

  try {
    // Create challenge without includes first
    const newChallenge = await prisma.challenge.create({
      data: {
        game,
        creatorId,
        inviteeId: targetInvitee,
        coins,
        xp: xp || 0,
        status: challengeStatus,
        description: description || null,
        rules: rules || { timeLimit: "30 minutes", maxMoves: 100 },
        isOpen,
        expiresAt: new Date(Date.now() + CONFIG.CHALLENGE_EXPIRY_MS),
      },
    });

    // Fetch creator and invitee user data separately
    const [creator, invitee] = await Promise.all([
      prisma.user.findUnique({
        where: { id: creatorId },
        select: { id: true, name: true, image: true },
      }),
      targetInvitee
        ? prisma.user.findUnique({
            where: { id: targetInvitee },
            select: { id: true, name: true, image: true },
          })
        : Promise.resolve(null),
    ]);

    // Attach user data to challenge object
    const enrichedChallenge = {
      ...newChallenge,
      User_Challenge_creatorIdToUser: creator,
      User_Challenge_inviteeIdToUser: invitee,
    };

    // Broadcast based on challenge type
    if (isOpen) {
      broadcastOpenChallenge(enrichedChallenge);
    } else {
      broadcastNewChallenge(enrichedChallenge);
    }
  } catch (error) {
    logger.error("Failed to create challenge:", {
      error: error instanceof Error ? error.message : String(error),
      creatorId,
      game,
    });
  }
}

async function handleAcceptChallenge(userInfo: MessagePayload): Promise<void> {
  const { gameId } = userInfo;

  if (!gameId) {
    logger.warn("acceptChallenge called without gameId");
    return;
  }

  try {
    const updatedChallenge = await prisma.challenge.update({
      where: { id: gameId },
      data: {
        status: "ACCEPTED",
        acceptedAt: new Date(),
      },
    });

    broadcastChallengeUpdate(updatedChallenge);
  } catch (error) {
    logger.error(`Failed to accept challenge ${gameId}:`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleJoinOpenChallenge(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { gameId, username, userId } = userInfo;

  if (!gameId || !userId) {
    logger.warn("joinOpenChallenge called with missing parameters");
    return;
  }

  const sendError = (message: string) => {
    try {
      ws.send(JSON.stringify({ type: "joinOpenChallengeFailed", message }));
    } catch (error) {
      logger.error("Failed to send error to client:", error);
    }
  };

  try {
    // Single query to get all needed data
    const [challenge, user] = await Promise.all([
      prisma.challenge.findUnique({
        where: { id: gameId },
        select: {
          status: true,
          isOpen: true,
          creatorId: true,
          inviteeId: true,
          coins: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true, name: true },
      }),
    ]);

    // Validate challenge
    if (!challenge) {
      sendError("Challenge not found");
      return;
    }

    if (!challenge.isOpen || challenge.status !== "PENDING") {
      sendError("Challenge is not available for joining");
      return;
    }

    if (challenge.creatorId === userId) {
      sendError("You cannot join your own challenge");
      return;
    }

    if (challenge.inviteeId) {
      sendError("Challenge already has a participant");
      return;
    }

    // Validate user
    if (!user) {
      sendError("User not found");
      return;
    }

    if (user.coins < challenge.coins) {
      sendError(
        `Insufficient coins. You need ${challenge.coins} coins but only have ${user.coins}`
      );
      return;
    }

    // Update challenge
    const updatedChallenge = await prisma.challenge.update({
      where: { id: gameId },
      data: {
        inviteeId: userId,
        status: "ACCEPTED",
        acceptedAt: new Date(),
        isOpen: false,
      },
    });

    broadcastChallengeUpdate(updatedChallenge);
  } catch (error) {
    logger.error(`Failed to join open challenge:`, {
      error: error instanceof Error ? error.message : String(error),
      gameId,
      userId,
    });
    sendError("Failed to join challenge");
  }
}

async function handleStartChallenge(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { gameId, userId } = userInfo;

  if (!gameId || !userId) {
    logger.warn("startChallenge called with missing parameters");
    return;
  }

  const sendError = (message: string) => {
    try {
      ws.send(JSON.stringify({ type: "failedToStartChallenge", message }));
    } catch (error) {
      logger.error("Failed to send error:", error);
    }
  };

  try {
    const challenge = await prisma.challenge.findUnique({
      where: { id: gameId },
    });

    if (!challenge) {
      sendError("Challenge not found");
      return;
    }

    // Only allow invitee to start
    if (userId !== challenge.inviteeId) {
      sendError("Only the invited player can start the challenge");
      return;
    }

    // Check if both users are online
    const bothOnline =
      state.isUserOnline(challenge.creatorId) &&
      state.isUserOnline(challenge.inviteeId!);

    if (!bothOnline) {
      sendError("Opponent is Offline");
      logger.info("Opponent offline, cannot start challenge");
      return;
    }

    if (challenge.status === "ACCEPTED") {
      // Directly start the game - no confirmation needed
      const updatedChallenge = await prisma.challenge.update({
        where: { id: gameId },
        data: { status: "IN_PROGRESS" },
      });

      broadcastGameStateUpdate(updatedChallenge);
      state.deleteChallengeState(gameId);
    } else {
      sendError("Challenge cannot be started from current status");
    }
  } catch (error) {
    logger.error("Failed to start challenge:", {
      error: error instanceof Error ? error.message : String(error),
      gameId,
      userId,
    });
    sendError("Failed to start challenge");
  }
}

async function handleClaimVictory(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { gameId, winnerUsername } = userInfo;

  if (!gameId) {
    logger.warn("claimVictory called without gameId");
    return;
  }

  const sendErrorToBoth = async (message: string) => {
    const challenge = await prisma.challenge.findUnique({
      where: { id: gameId },
      select: { creatorId: true, inviteeId: true },
    });

    if (challenge) {
      broadcastToChallengePlayers(challenge.creatorId, challenge.inviteeId, {
        type: "claimVictoryFailed",
        message,
      });
    }
  };

  try {
    const gameSelections = state.getWinnerSelections(gameId);

    if (!gameSelections) {
      await sendErrorToBoth(
        "No winner selections found. Both players must select a winner first."
      );
      return;
    }

    const challenge = await prisma.challenge.findUnique({
      where: { id: gameId },
      select: { creatorId: true, inviteeId: true },
    });

    if (!challenge) {
      try {
        ws.send(
          JSON.stringify({
            type: "claimVictoryFailed",
            message: "Challenge not found.",
          })
        );
      } catch (error) {
        logger.error("Failed to send error:", error);
      }
      return;
    }

    const creatorSelection = gameSelections.get(challenge.creatorId);
    const inviteeSelection = gameSelections.get(challenge.inviteeId!);

    if (!creatorSelection || !inviteeSelection) {
      await sendErrorToBoth(
        "Both players must select a winner before claiming victory."
      );
      return;
    }

    if (creatorSelection !== inviteeSelection) {
      await sendErrorToBoth(
        "Players disagree on the winner. Please discuss and reselect."
      );
      return;
    }

    // Both players agree - complete the challenge
    const [updatedChallenge] = await prisma.$transaction([
      prisma.challenge.update({
        where: { id: gameId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          winnerId: creatorSelection,
        },
      }),
      prisma.winnerSelection.deleteMany({
        where: { challengeId: gameId },
      }),
    ]);

    logger.info(
      `Challenge ${gameId} completed with winner ${creatorSelection}`
    );

    // Clean up memory
    state.deleteWinnerSelections(gameId);

    // Broadcast completion
    broadcastToChallengePlayers(challenge.creatorId, challenge.inviteeId, {
      type: "challengeCompleted",
      updatedChallenge,
    });
  } catch (error) {
    logger.error("Failed to claim victory:", {
      error: error instanceof Error ? error.message : String(error),
      gameId,
    });

    try {
      ws.send(
        JSON.stringify({
          type: "claimVictoryFailed",
          message: "Failed to update challenge status.",
        })
      );
    } catch (sendError) {
      logger.error("Failed to send error:", sendError);
    }
  }
}

// Graceful Shutdown Handler
function setupGracefulShutdown(): void {
  const shutdown = async () => {
    logger.info("Received shutdown signal, closing server gracefully...");

    // Stop accepting new connections
    wss.close(() => {
      logger.info("WebSocket server closed");
    });

    // Clear intervals
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }

    // Close all connections
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1000, "Server shutting down");
      }
    });

    // Disconnect Prisma
    await prisma.$disconnect();
    logger.info("Database connections closed");

    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Server Startup
async function startServer(): Promise<void> {
  try {
    // Load initial data
    await loadWinnerSelectionsFromDB();

    // Setup graceful shutdown
    setupGracefulShutdown();

    logger.info(`WebSocket server running on ws://localhost:${CONFIG.PORT}`);
    logger.info(`Max connections: ${CONFIG.MAX_CONNECTIONS}`);
    logger.info(`Cleanup interval: ${CONFIG.CLEANUP_INTERVAL_MS}ms`);
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();
