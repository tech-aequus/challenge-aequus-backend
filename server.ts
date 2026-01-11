import WebSocket, { WebSocketServer } from "ws";
import prisma from "./db";
import { logger } from "./utils/logger";
import type { $Enums } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

const wss = new WebSocketServer({ port: Number(process.env.PORT) || 8080 });
const onlineUsers = new Map();
const startChallengeMap = new Map();

const winnerSelections = new Map(); // Format: Map<gameId, Map<playerId, selectedWinner>>

// Load winner selections from database on startup
async function loadWinnerSelectionsFromDB() {
  try {
    const selections = await prisma.winnerSelection.findMany({
      include: {
        Challenge: {
          select: { status: true }
        }
      }
    });

    selections.forEach(selection => {
      // Only load selections for active challenges
      if (selection.Challenge.status === 'IN_PROGRESS') {
        if (!winnerSelections.has(selection.challengeId)) {
          winnerSelections.set(selection.challengeId, new Map());
        }
        const gameSelections = winnerSelections.get(selection.challengeId);
        gameSelections.set(selection.playerId, selection.selectedWinner);
      }
    });

    logger.info(`Loaded ${selections.length} winner selections from database`);
  } catch (error) {
    logger.error(`Failed to load winner selections from database: ${error}`);
  }
}

// Helper function to enrich challenge data with winner selections
function enrichChallengeWithSelections(challenge: any) {
  const selections = winnerSelections.get(challenge.id);
  const selectionsObj: Record<string, string> = {};

  if (selections) {
    selections.forEach((winner: string, player: string) => {
      selectionsObj[player] = winner;
    });
  }

  return {
    ...challenge,
    winnerSelections: selectionsObj,
  };
}

function broadcastOnlineUsers() {
  const onlineUsernames = Array.from(onlineUsers.keys());
  const message = JSON.stringify({
    type: "onlineUsers",
    users: onlineUsernames,
  });

  onlineUsers.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
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

  const message = JSON.stringify({
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
    type: `challengeStartedBy`,
    updateState: enrichedState,
  });
  usersInChallenge.forEach((ws) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
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
}

wss.on("connection", (ws: WebSocket) => {
  logger.info("A new client connected");
  ws.on("error", console.error);

  ws.on("message", async (message: string) => {
    try {
      const userInfo = JSON.parse(message);
      console.log("Received message:", userInfo);

      if (userInfo.type === "setOnline") {
        const userExists = await prisma.user.findUnique({
          where: { name: userInfo.username },
          select: { id: true },
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

          logger.info(`📊 Found ${dbSelections.length} winner selections in database`);

          // Update memory cache and build response
          const allSelections: Record<string, Record<string, string>> = {};

          dbSelections.forEach(selection => {
            // Only include selections for active challenges
            if (selection.Challenge.status === 'IN_PROGRESS') {
              if (!allSelections[selection.challengeId]) {
                allSelections[selection.challengeId] = {};
              }
              allSelections[selection.challengeId][selection.playerId] = selection.selectedWinner;

              // Update memory cache
              if (!winnerSelections.has(selection.challengeId)) {
                winnerSelections.set(selection.challengeId, new Map());
              }
              const gameSelections = winnerSelections.get(selection.challengeId);
              gameSelections.set(selection.playerId, selection.selectedWinner);
            } else {
              logger.info(`⏭️ Skipping selection for challenge ${selection.challengeId} with status ${selection.Challenge.status}`);
            }
          });

          logger.info(`📤 Sending winner selections to client:`, JSON.stringify(allSelections, null, 2));

          ws.send(
            JSON.stringify({
              type: "allWinnerSelections",
              selections: allSelections,
            })
          );
        } catch (error) {
          logger.error(`Failed to load winner selections from database: ${error}`);
          // Fallback to memory cache
          const allSelections: Record<string, Record<string, string>> = {};
          winnerSelections.forEach((gameSelections, gameId: string) => {
            const selectionsObj: Record<string, string> = {};
            gameSelections.forEach((winner: string, player: string) => {
              selectionsObj[player] = winner;
            });
            allSelections[gameId] = selectionsObj;
          });

          logger.info(`📤 Sending fallback winner selections to client:`, JSON.stringify(allSelections, null, 2));

          ws.send(
            JSON.stringify({
              type: "allWinnerSelections",
              selections: allSelections,
            })
          );
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
    // Fetch the updated challenge (server action already updated it)
    const updatedChallenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
    });

    if (!updatedChallenge) {
      logger.error(`Challenge ${challengeId} not found`);
      return;
    }

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
    logger.error(`Failed to broadcast challenge update ${challengeId}:`, {
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
            ws.send(
              JSON.stringify({
                type: "joinOpenChallengeFailed",
                message: `Insufficient coins. You need ${challenge.coins} coins but only have ${user.coins}`,
              })
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
          ws.send(
            JSON.stringify({
              type: "failedToStartChallenge",
              message: "Challenge not found",
            })
          );
          logger.info(`Challenge ${gameId} not found`);
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
          ws.send(
            JSON.stringify({
              type: "claimVictoryFailed",
              message: "Challenge not found.",
            })
          );
          return;
        }

        const creatorSelection = gameSelections.get(challenge.creatorId);
        const inviteeSelection = gameSelections.get(challenge.inviteeId);

        logger.info(
          `Victory claim attempt - GameId: ${gameId}, CreatorSelection: ${creatorSelection}, InviteeSelection: ${inviteeSelection}, ClaimedBy: ${winnerUsername}`
        );

        // Check if both players have made selections and they agree
        if (!creatorSelection || !inviteeSelection) {
          const incompleteSelectionsMessage = JSON.stringify({
            type: "claimVictoryFailed",
            message:
              "Both players must select a winner before claiming victory.",
          });

          const creatorWs = onlineUsers.get(challenge.creatorId);
          const inviteeWs = onlineUsers.get(challenge.inviteeId);

          if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
            creatorWs.send(incompleteSelectionsMessage);
          }
          if (inviteeWs && inviteeWs.readyState === WebSocket.OPEN) {
            inviteeWs.send(incompleteSelectionsMessage);
          }

          return;
        }

        if (creatorSelection !== inviteeSelection) {
          // Broadcast disagreement message to both players
          const disagreementMessage = JSON.stringify({
            type: "claimVictoryFailed",
            message:
              "Players disagree on the winner. Please discuss and reselect.",
          });

          const creatorWs = onlineUsers.get(challenge.creatorId);
          const inviteeWs = onlineUsers.get(challenge.inviteeId);

          if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
            creatorWs.send(disagreementMessage);
          }
          if (inviteeWs && inviteeWs.readyState === WebSocket.OPEN) {
            inviteeWs.send(disagreementMessage);
          }

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
    }
    console.log("WebSocket connection closed");
  });
});

// Load winner selections from database on server startup
loadWinnerSelectionsFromDB();

logger.info(`WebSocket server is running on ws://localhost:${process.env.PORT || 8080}`);
