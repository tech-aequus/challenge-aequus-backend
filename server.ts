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
} // Type for Challenge Data
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
  isOpen: boolean;
};

function broadcastChallengeUpdate(updatedChallenge: ChallengeData): void {
  const enrichedChallenge = enrichChallengeWithSelections(updatedChallenge);
  const message: MessagePayload = {
    type: "challengeAccepted",
    challenge: enrichedChallenge,
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
    challenge: newChallenge,
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
        case "broadcastChallenge":
          await handleBroadcastChallenge(userInfo);
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
  const { challengeId, playerId, winnerId } = userInfo;

  // Validation
  if (!challengeId || !playerId || !winnerId) {
    logger.warn("selectWinner called with missing parameters", {
      challengeId,
      playerId,
      winnerId,
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
            challengeId: challengeId,
            playerId: playerId,
          },
        },
        create: {
          challengeId: challengeId,
          playerId: playerId,
          selectedWinner: winnerId,
        },
        update: {
          selectedWinner: winnerId,
          updatedAt: new Date(),
        },
      });

      // Fetch challenge data
      const challengeData = await tx.challenge.findUnique({
        where: { id: challengeId },
      });

      return [selection, challengeData];
    });

    if (!challenge) {
      logger.error(`Challenge not found: ${challengeId}`);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Challenge not found",
        })
      );
      return;
    }

    // Update in-memory cache
    state.setWinnerSelection(challengeId, playerId, winnerId);

    // Enrich and broadcast
    const enrichedChallenge = enrichChallengeWithSelections(challenge);

    broadcastToChallengePlayers(challenge.creatorId, challenge.inviteeId, {
      type: "challengeUpdate",
      challenge: enrichedChallenge,
    });
  } catch (error) {
    logger.error(`Failed to save winner selection:`, {
      error: error instanceof Error ? error.message : String(error),
      challengeId,
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

/**
 * Handle broadcasting an already-created challenge from the database
 * This is called after a server action creates the challenge
 */
async function handleBroadcastChallenge(
  userInfo: MessagePayload
): Promise<void> {
  const { challenge } = userInfo;

  if (!challenge || !challenge.id) {
    logger.warn("broadcastChallenge called without valid challenge");
    return;
  }

  // Broadcast based on challenge type
  if (challenge.isOpen) {
    broadcastOpenChallenge(challenge);
  } else {
    broadcastNewChallenge(challenge);
  }
}

async function handleAcceptChallenge(userInfo: MessagePayload): Promise<void> {
  const { challengeId } = userInfo;

  if (!challengeId) {
    logger.warn("acceptChallenge called without challengeId");
    return;
  }

  try {
    const updatedChallenge = await prisma.challenge.update({
      where: { id: challengeId },
      data: {
        status: "ACCEPTED",
        acceptedAt: new Date(),
      },
    });

    // Fetch users separately to avoid null constraint errors
    const [creator, invitee] = await Promise.all([
      prisma.user.findUnique({
        where: { id: updatedChallenge.creatorId },
        select: { id: true, name: true, image: true },
      }),
      updatedChallenge.inviteeId
        ? prisma.user.findUnique({
            where: { id: updatedChallenge.inviteeId },
            select: { id: true, name: true, image: true },
          })
        : Promise.resolve(null),
    ]);

    // Enrich challenge with user data
    const enrichedChallenge = {
      ...updatedChallenge,
      User_Challenge_creatorIdToUser: creator,
      User_Challenge_inviteeIdToUser: invitee,
    };

    broadcastChallengeUpdate(enrichedChallenge as any);
  } catch (error) {
    logger.error(`Failed to accept challenge ${challengeId}:`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleJoinOpenChallenge(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { challengeId, userId } = userInfo;

  if (!challengeId || !userId) {
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
    // Get current challenge state
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: {
        status: true,
        isOpen: true,
        creatorId: true,
        inviteeId: true,
        coins: true,
      },
    });

    // Validate challenge exists
    if (!challenge) {
      sendError("Challenge not found");
      return;
    }

    // Check if user is the creator
    if (challenge.creatorId === userId) {
      sendError("You cannot join your own challenge");
      return;
    }

    // If user is already the invitee (joined via server action), ensure status is ACCEPTED and broadcast
    if (challenge.inviteeId === userId) {
      logger.info(
        `User ${userId} already joined challenge ${challengeId}, ensuring ACCEPTED status and broadcasting`
      );

      // Update challenge to ACCEPTED status if not already
      const updatedChallenge = await prisma.challenge.update({
        where: { id: challengeId },
        data: {
          status: "ACCEPTED",
          acceptedAt: new Date(),
        },
      });

      // Fetch users separately
      const [creator, invitee] = await Promise.all([
        prisma.user.findUnique({
          where: { id: updatedChallenge.creatorId },
          select: { id: true, name: true, image: true },
        }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, image: true },
        }),
      ]);

      const enrichedChallenge = {
        ...updatedChallenge,
        User_Challenge_creatorIdToUser: creator,
        User_Challenge_inviteeIdToUser: invitee,
      };

      broadcastChallengeUpdate(enrichedChallenge as any);
      return;
    }

    // If challenge has a different invitee, reject
    if (challenge.inviteeId && challenge.inviteeId !== userId) {
      sendError("Challenge already has a participant");
      return;
    }

    // Check if challenge is available for joining
    if (challenge.status !== "PENDING") {
      sendError("Challenge is not available for joining");
      return;
    }

    // Validate user exists and has enough coins
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true, name: true },
    });

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

    // Update challenge - set inviteeId and accept it
    const updatedChallenge = await prisma.challenge.update({
      where: { id: challengeId },
      data: {
        inviteeId: userId,
        status: "ACCEPTED",
        acceptedAt: new Date(),
      },
    });

    // Fetch users separately
    const [creator, invitee] = await Promise.all([
      prisma.user.findUnique({
        where: { id: updatedChallenge.creatorId },
        select: { id: true, name: true, image: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, image: true },
      }),
    ]);

    const enrichedChallenge = {
      ...updatedChallenge,
      User_Challenge_creatorIdToUser: creator,
      User_Challenge_inviteeIdToUser: invitee,
    };

    broadcastChallengeUpdate(enrichedChallenge as any);
  } catch (error) {
    logger.error(`Failed to join open challenge:`, {
      error: error instanceof Error ? error.message : String(error),
      challengeId,
      userId,
    });
    sendError("Failed to join challenge");
  }
}

async function handleStartChallenge(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { challengeId, userId } = userInfo;

  if (!challengeId || !userId) {
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
      where: { id: challengeId },
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
        where: { id: challengeId },
        data: { status: "IN_PROGRESS" },
      });

      // Fetch users separately
      const [creator, invitee] = await Promise.all([
        prisma.user.findUnique({
          where: { id: updatedChallenge.creatorId },
          select: { id: true, name: true, image: true },
        }),
        updatedChallenge.inviteeId
          ? prisma.user.findUnique({
              where: { id: updatedChallenge.inviteeId },
              select: { id: true, name: true, image: true },
            })
          : Promise.resolve(null),
      ]);

      const enrichedChallenge = {
        ...updatedChallenge,
        User_Challenge_creatorIdToUser: creator,
        User_Challenge_inviteeIdToUser: invitee,
      };

      broadcastGameStateUpdate(enrichedChallenge as any);
      state.deleteChallengeState(challengeId);
    } else {
      sendError("Challenge cannot be started from current status");
    }
  } catch (error) {
    logger.error("Failed to start challenge:", {
      error: error instanceof Error ? error.message : String(error),
      challengeId,
      userId,
    });
    sendError("Failed to start challenge");
  }
}

async function handleClaimVictory(
  ws: WebSocket,
  userInfo: MessagePayload
): Promise<void> {
  const { challengeId } = userInfo;

  if (!challengeId) {
    logger.warn("claimVictory called without challengeId");
    return;
  }

  const sendErrorToBoth = async (message: string) => {
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
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
    const gameSelections = state.getWinnerSelections(challengeId);

    if (!gameSelections) {
      await sendErrorToBoth(
        "No winner selections found. Both players must select a winner first."
      );
      return;
    }

    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { creatorId: true, inviteeId: true, coins: true },
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

    const winnerId = creatorSelection;
    const loserId =
      winnerId === challenge.creatorId
        ? challenge.inviteeId!
        : challenge.creatorId;

    // Complete the challenge - coins are already awarded by the frontend
    const [updatedChallenge] = await prisma.$transaction([
      prisma.challenge.update({
        where: { id: challengeId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          winnerId: winnerId,
        },
      }),
      prisma.winnerSelection.deleteMany({
        where: { challengeId: challengeId },
      }),
    ]);

    // Fetch users separately after transaction
    const [creator, invitee] = await Promise.all([
      prisma.user.findUnique({
        where: { id: updatedChallenge.creatorId },
        select: { id: true, name: true, image: true },
      }),
      updatedChallenge.inviteeId
        ? prisma.user.findUnique({
            where: { id: updatedChallenge.inviteeId },
            select: { id: true, name: true, image: true },
          })
        : Promise.resolve(null),
    ]);

    const enrichedChallenge = {
      ...updatedChallenge,
      User_Challenge_creatorIdToUser: creator,
      User_Challenge_inviteeIdToUser: invitee,
    };

    logger.info(`Challenge ${challengeId} completed with winner ${winnerId}`);

    // Clean up memory
    state.deleteWinnerSelections(challengeId);

    // Broadcast completion
    broadcastToChallengePlayers(challenge.creatorId, challenge.inviteeId, {
      type: "challengeCompleted",
      challengeId: challengeId,
      winnerId: winnerId,
      challenge: enrichedChallenge,
    });
  } catch (error) {
    logger.error("Failed to claim victory:", {
      error: error instanceof Error ? error.message : String(error),
      challengeId,
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
