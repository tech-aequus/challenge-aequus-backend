import WebSocket, { WebSocketServer } from "ws";
import prisma from "./db";
import { logger } from "./utils/logger";
import type { $Enums } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

const wss = new WebSocketServer({ port: Number(process.env.PORT) || 8080 });
const onlineUsers = new Map(); // Map<userId, { ws: WebSocket, name: string }>
const startChallengeMap = new Map(); // Map<challengeId, { creatorStarted: boolean, opponentStarted: boolean, timestamp: number }>

const winnerSelections = new Map(); // Format: Map<gameId, Map<playerId, selectedWinner>>

// Cleanup stale challenge start attempts (older than 5 minutes)
setInterval(() => {
  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;

  for (const [challengeId, data] of startChallengeMap.entries()) {
    if (now - data.timestamp > FIVE_MINUTES) {
      startChallengeMap.delete(challengeId);
      logger.info(
        `Cleaned up stale start attempt for challenge ${challengeId}`
      );
    }
  }
}, 60000); // Run every minute

// Load winner selections from database on startup
async function loadWinnerSelectionsFromDB() {
  try {
    const selections = await prisma.winnerSelection.findMany({
      include: {
        Challenge: {
          select: { status: true },
        },
      },
    });

    selections.forEach((selection) => {
      // Only load selections for active challenges
      if (selection.Challenge.status === "IN_PROGRESS") {
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
  const onlineUsersList = Array.from(onlineUsers.entries()).map(
    ([userId, data]) => ({
      id: userId,
      name: data.name,
    })
  );
  const message = JSON.stringify({
    type: "onlineUsers",
    users: onlineUsersList,
  });

  onlineUsers.forEach((data) => {
    if (data.ws.readyState === WebSocket.OPEN) {
      data.ws.send(message);
    }
  });
}

function broadcastToChallengePlayers(
  creatorId: string,
  inviteeId: string | null,
  message: any
) {
  const players = [creatorId, inviteeId].filter(Boolean);
  players.forEach((playerId) => {
    const playerData = onlineUsers.get(playerId);
    if (playerData && playerData.ws.readyState === WebSocket.OPEN) {
      playerData.ws.send(JSON.stringify(message));
    }
  });
}

function broadcastChallengeUpdate(updatedChallenge: {
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
}) {
  const usersInChallenge = [
    updatedChallenge.creatorId,
    updatedChallenge.inviteeId,
  ]
    .filter(Boolean)
    .map((userId) => onlineUsers.get(userId))
    .filter((data) => data);

  const enrichedChallenge = enrichChallengeWithSelections(updatedChallenge);

  const message = JSON.stringify({
    type: "challengeAccepted",
    updatedChallenge: enrichedChallenge,
  });
  usersInChallenge.forEach((data) => {
    if (data?.ws.readyState === WebSocket.OPEN) {
      data.ws.send(message);
    }
  });
}

function broadcastGameStateUpdate(updateState: {
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
}) {
  const usersInChallenge = [updateState.creatorId, updateState.inviteeId]
    .filter(Boolean)
    .map((userId) => onlineUsers.get(userId))
    .filter((data) => data);

  const enrichedState = enrichChallengeWithSelections(updateState);

  const message = JSON.stringify({
    type: `challengeStartedBy`,
    updateState: enrichedState,
  });
  usersInChallenge.forEach((data) => {
    if (data?.ws.readyState === WebSocket.OPEN) {
      data.ws.send(message);
    }
  });
}

function broadcastNewChallenge(newChallenge: {
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
}) {
  const usersInChallenge = [newChallenge.creatorId, newChallenge.inviteeId]
    .filter(Boolean)
    .map((userId) => onlineUsers.get(userId))
    .filter((data) => data);

  const message = JSON.stringify({ type: "challengeCreated", newChallenge });

  usersInChallenge.forEach((data) => {
    if (data?.ws.readyState === WebSocket.OPEN) {
      data.ws.send(message);
    }
  });
}

function broadcastOpenChallenge(newChallenge: {
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
}) {
  const message = JSON.stringify({
    type: "openChallengeCreated",
    newChallenge,
  });

  // Broadcast to all online users
  onlineUsers.forEach((data) => {
    if (data.ws.readyState === WebSocket.OPEN) {
      data.ws.send(message);
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
          where: { id: userInfo.userId },
          select: { id: true, name: true },
        });

        if (userInfo.online && userExists) {
          onlineUsers.set(userInfo.userId, { ws, name: userExists.name });

          logger.info(`${userExists.name} (${userInfo.userId}) is now online`);
          broadcastOnlineUsers();
        } else {
          logger.info(`${userInfo.userId} does not exist in the database`);
        }
      }

      // Handle winner selection
      if (userInfo.type === "selectWinner") {
        const { gameId, playerId, selectedWinner } = userInfo;

        logger.info(
          `Winner selection received: gameId=${gameId}, playerId=${playerId}, selectedWinner=${selectedWinner}`
        );

        try {
          // Save to database using upsert (create or update)
          await prisma.winnerSelection.upsert({
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

          // Initialize the game's selections if it doesn't exist
          if (!winnerSelections.has(gameId)) {
            winnerSelections.set(gameId, new Map());
          }

          // Store the selection in memory cache
          const gameSelections = winnerSelections.get(gameId);
          gameSelections.set(playerId, selectedWinner);

          // Fetch the full challenge data
          const challenge = await prisma.challenge.findUnique({
            where: { id: gameId },
          });

          if (!challenge) {
            logger.error(`Challenge not found: ${gameId}`);
            return;
          }

          // Enrich challenge with winner selections
          const enrichedChallenge = enrichChallengeWithSelections(challenge);

          logger.info(
            `Broadcasting updated challenge with selections for ${gameId}:`,
            JSON.stringify(enrichedChallenge.winnerSelections)
          );

          // Broadcast the full challenge update to both players
          const usersInChallenge = [challenge.creatorId, challenge.inviteeId]
            .filter(Boolean)
            .map((userId) => onlineUsers.get(userId))
            .filter((data) => data);

          const message = JSON.stringify({
            type: "challengeUpdate",
            challenge: enrichedChallenge,
          });

          usersInChallenge.forEach((data) => {
            if (data?.ws.readyState === WebSocket.OPEN) {
              data.ws.send(message);
            }
          });

          logger.info(
            `Winner selection saved and challenge update broadcasted for ${gameId}`
          );
        } catch (error) {
          logger.error(`Failed to save winner selection to database: ${error}`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to save winner selection",
            })
          );
        }
      }

      // Handle request for all winner selections
      if (userInfo.type === "getWinnerSelections") {
        logger.info(`📥 getWinnerSelections request from ${userInfo.username}`);
        try {
          // Load fresh data from database
          const dbSelections = await prisma.winnerSelection.findMany({
            include: {
              Challenge: {
                select: { status: true },
              },
            },
          });

          logger.info(
            `📊 Found ${dbSelections.length} winner selections in database`
          );

          // Update memory cache and build response
          const allSelections: Record<string, Record<string, string>> = {};

          dbSelections.forEach((selection) => {
            // Only include selections for active challenges
            if (selection.Challenge.status === "IN_PROGRESS") {
              if (!allSelections[selection.challengeId]) {
                allSelections[selection.challengeId] = {};
              }
              allSelections[selection.challengeId][selection.playerId] =
                selection.selectedWinner;

              // Update memory cache
              if (!winnerSelections.has(selection.challengeId)) {
                winnerSelections.set(selection.challengeId, new Map());
              }
              const gameSelections = winnerSelections.get(
                selection.challengeId
              );
              gameSelections.set(selection.playerId, selection.selectedWinner);
            } else {
              logger.info(
                `⏭️ Skipping selection for challenge ${selection.challengeId} with status ${selection.Challenge.status}`
              );
            }
          });

          logger.info(
            `📤 Sending winner selections to client:`,
            JSON.stringify(allSelections, null, 2)
          );

          ws.send(
            JSON.stringify({
              type: "allWinnerSelections",
              selections: allSelections,
            })
          );
        } catch (error) {
          logger.error(
            `Failed to load winner selections from database: ${error}`
          );
          // Fallback to memory cache
          const allSelections: Record<string, Record<string, string>> = {};
          winnerSelections.forEach((gameSelections, gameId: string) => {
            const selectionsObj: Record<string, string> = {};
            gameSelections.forEach((winner: string, player: string) => {
              selectionsObj[player] = winner;
            });
            allSelections[gameId] = selectionsObj;
          });

          logger.info(
            `📤 Sending fallback winner selections to client:`,
            JSON.stringify(allSelections, null, 2)
          );

          ws.send(
            JSON.stringify({
              type: "allWinnerSelections",
              selections: allSelections,
            })
          );
        }
      }

      if (userInfo.type === "createChallenge") {
        const {
          creatorId,
          coins,
          xp,
          inviteeId,
          game,
          description,
          rules,
          isOpen = false,
          status,
        } = userInfo;

        console.log(userInfo);

        // Use the new unified approach: inviteeId for target user, isOpen for open challenges
        const targetInvitee = isOpen ? null : inviteeId || inviteeId;
        const challengeStatus = "PENDING"; // All challenges start as PENDING

        const newChallenge = await prisma.challenge.create({
          data: {
            game,
            creatorId: creatorId,
            inviteeId: targetInvitee,
            coins,
            xp,
            status: challengeStatus,
            description: description || null,
            rules: rules || { timeLimit: "30 minutes", maxMoves: 100 },
            isOpen: isOpen,
            expiresAt: new Date(new Date().getTime() + 24 * 60 * 60 * 1000),
          },
        }); // For open challenges, broadcast to all online users. For private challenges, broadcast to specific users
        if (isOpen) {
          broadcastOpenChallenge(newChallenge);
        } else {
          broadcastNewChallenge(newChallenge);
        }

        logger.info(
          isOpen
            ? `A new open challenge is created by ${creatorId} for ${game}`
            : `A new challenge is created between ${creatorId} and ${targetInvitee}`
        );
      }

      if (userInfo.type === "acceptChallenge") {
        const { gameId } = userInfo;
        try {
          const updatedChallenge = await prisma.challenge.update({
            where: { id: gameId },
            data: {
              status: "ACCEPTED",
              acceptedAt: new Date(),
            },
          });
          logger.info(`Challenge ${gameId} status updated to ACCEPTED`);
          broadcastChallengeUpdate(updatedChallenge);
        } catch (error) {
          logger.error(`Failed to update challenge ${gameId}: ${error}`);
        }
      }

      // Handle joining open challenges
      if (userInfo.type === "joinOpenChallenge") {
        const { gameId, username, userId } = userInfo;
        try {
          // Check if challenge exists and is open
          const challenge = await prisma.challenge.findUnique({
            where: { id: gameId },
            select: {
              status: true,
              isOpen: true,
              creatorId: true,
              inviteeId: true,
              coins: true, // Include coins amount needed for validation
            },
          });

          if (!challenge) {
            ws.send(
              JSON.stringify({
                type: "joinOpenChallengeFailed",
                message: "Challenge not found",
              })
            );
            return;
          }

          if (!challenge.isOpen || challenge.status !== "PENDING") {
            ws.send(
              JSON.stringify({
                type: "joinOpenChallengeFailed",
                message: "Challenge is not available for joining",
              })
            );
            return;
          }

          if (challenge.creatorId === userId) {
            ws.send(
              JSON.stringify({
                type: "joinOpenChallengeFailed",
                message: "You cannot join your own challenge",
              })
            );
            return;
          }

          if (challenge.inviteeId) {
            ws.send(
              JSON.stringify({
                type: "joinOpenChallengeFailed",
                message: "Challenge already has a participant",
              })
            );
            return;
          }

          // Check if the user has sufficient coins before allowing them to join
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { coins: true, name: true },
          });

          if (!user) {
            ws.send(
              JSON.stringify({
                type: "joinOpenChallengeFailed",
                message: "User not found",
              })
            );
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

          // Update challenge with the joining user and change status to ACCEPTED
          const updatedChallenge = await prisma.challenge.update({
            where: { id: gameId },
            data: {
              inviteeId: userId,
              status: "ACCEPTED",
              acceptedAt: new Date(),
              isOpen: false, // No longer open once someone joins
            },
          });

          logger.info(`User ${username} joined open challenge ${gameId}`);
          broadcastChallengeUpdate(updatedChallenge);
        } catch (error) {
          logger.error(`Failed to join open challenge ${gameId}: ${error}`);
          ws.send(
            JSON.stringify({
              type: "joinOpenChallengeFailed",
              message: "Failed to join challenge",
            })
          );
        }
      }

      if (userInfo.type === "startChallenge") {
        const { gameId, userId } = userInfo; // Only need userId of the person clicking start
        logger.info(
          `Start challenge requested by ${userId} for gameId ${gameId}`
        );
        console.log(userInfo);

        const challenge = await prisma.challenge.findUnique({
          where: { id: gameId },
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

        // Check if both users are online
        const isUserOnline =
          onlineUsers.has(challenge.inviteeId!) &&
          onlineUsers.has(challenge.creatorId);
        logger.info(`Are both users online? ${isUserOnline}`);

        console.log("Online users:", Array.from(onlineUsers.keys()));

        if (!isUserOnline) {
          ws.send(
            JSON.stringify({
              type: "failedToStartChallenge",
              message: "Opponent is Offline",
            })
          );
          logger.info(`Opponent is offline, cannot start challenge`);
          return;
        }

        const currentStatus = challenge.status;
        logger.info(`Current challenge status: ${currentStatus}`);

        if (!startChallengeMap.has(gameId)) {
          startChallengeMap.set(gameId, {
            creatorStarted: false,
            opponentStarted: false,
            timestamp: Date.now(),
          });
        }

        const challengeState = startChallengeMap.get(gameId);
        const isCreator = userId === challenge.creatorId;
        const isInvitee = userId === challenge.inviteeId;

        if (currentStatus === "STARTING") {
          if (isCreator && challengeState.creatorStarted) {
            ws.send(
              JSON.stringify({
                type: "failedToStartChallenge",
                message: "You already started the challenge",
              })
            );
            logger.info(`${userId} has already started the challenge`);
            return;
          }
          if (isInvitee && challengeState.opponentStarted) {
            ws.send(
              JSON.stringify({
                type: "failedToStartChallenge",
                message: "You already started the challenge",
              })
            );
            logger.info(`${userId} has already started the challenge`);
            return;
          }
          if (isCreator) {
            challengeState.creatorStarted = true;
          } else if (isInvitee) {
            challengeState.opponentStarted = true;
          }

          logger.info(`Marked ${userId} as started in usersStarted map`);
          if (challengeState.creatorStarted && challengeState.opponentStarted) {
            logger.info(
              `Both users started the challenge, setting to IN_PROGRESS`
            );

            const updatedChallenge = await prisma.challenge.update({
              where: { id: gameId },
              data: { status: "IN_PROGRESS" },
            });

            broadcastGameStateUpdate(updatedChallenge);

            // Clean up immediately when challenge starts
            startChallengeMap.delete(gameId);
          } else {
            // Broadcast the state update so the other player knows someone is waiting
            broadcastGameStateUpdate(challenge);
          }
        } else if (currentStatus === "ACCEPTED") {
          logger.info(`Challenge is in ACCEPTED state, moving to STARTING`);

          const updatedChallenge = await prisma.challenge.update({
            where: { id: gameId },
            data: { status: "STARTING" },
          });

          if (isCreator) {
            challengeState.creatorStarted = true;
          } else if (isInvitee) {
            challengeState.opponentStarted = true;
          }
          logger.info(`Marked ${userId} as started in usersStarted map`);

          broadcastGameStateUpdate(updatedChallenge);
        } else {
          ws.send(
            JSON.stringify({
              type: "failedToStartChallenge",
              message: "Challenge already ongoing or completed",
            })
          );
          logger.info(`Challenge already ongoing or completed`);
        }
      }

      if (userInfo.type === "claimVictory") {
        const { gameId, winnerUsername } = userInfo;

        // Check if both players have selected the same winner
        const gameSelections = winnerSelections.get(gameId);
        if (!gameSelections) {
          // Get challenge details to broadcast to both players
          const challenge = await prisma.challenge.findUnique({
            where: { id: gameId },
            select: { creatorId: true, inviteeId: true },
          });

          if (challenge) {
            const noSelectionsMessage = JSON.stringify({
              type: "claimVictoryFailed",
              message:
                "No winner selections found. Both players must select a winner first.",
            });

            const creatorData = onlineUsers.get(challenge.creatorId);
            const inviteeData = onlineUsers.get(challenge.inviteeId);

            if (creatorData && creatorData.ws.readyState === WebSocket.OPEN) {
              creatorData.ws.send(noSelectionsMessage);
            }
            if (inviteeData && inviteeData.ws.readyState === WebSocket.OPEN) {
              inviteeData.ws.send(noSelectionsMessage);
            }
          } else {
            ws.send(
              JSON.stringify({
                type: "claimVictoryFailed",
                message: "Challenge not found.",
              })
            );
          }
          return;
        }

        // Get challenge details
        const challenge = await prisma.challenge.findUnique({
          where: { id: gameId },
          select: { creatorId: true, inviteeId: true },
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

          const creatorData = onlineUsers.get(challenge.creatorId);
          const inviteeData = onlineUsers.get(challenge.inviteeId);

          if (creatorData && creatorData.ws.readyState === WebSocket.OPEN) {
            creatorData.ws.send(incompleteSelectionsMessage);
          }
          if (inviteeData && inviteeData.ws.readyState === WebSocket.OPEN) {
            inviteeData.ws.send(incompleteSelectionsMessage);
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

          const creatorData = onlineUsers.get(challenge.creatorId);
          const inviteeData = onlineUsers.get(challenge.inviteeId);

          if (creatorData && creatorData.ws.readyState === WebSocket.OPEN) {
            creatorData.ws.send(disagreementMessage);
          }
          if (inviteeData && inviteeData.ws.readyState === WebSocket.OPEN) {
            inviteeData.ws.send(disagreementMessage);
          }

          return;
        }

        // If we get here, both players agree on the winner
        try {
          const updatedChallenge = await prisma.challenge.update({
            where: { id: gameId },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              winnerId: creatorSelection, // Use the agreed-upon winner
            },
          });

          logger.info(
            `Challenge ${gameId} status updated to COMPLETED with winner ${creatorSelection}`
          );

          const message = JSON.stringify({
            type: "challengeCompleted",
            updatedChallenge,
          });

          onlineUsers.get(updatedChallenge.creatorId)?.ws.send(message);
          onlineUsers.get(updatedChallenge.inviteeId)?.ws.send(message);

          // Clean up winner selections for this game from both memory and database
          winnerSelections.delete(gameId);

          try {
            await prisma.winnerSelection.deleteMany({
              where: { challengeId: gameId },
            });
            logger.info(
              `Cleaned up winner selections for completed challenge ${gameId}`
            );
          } catch (error) {
            logger.error(
              `Failed to clean up winner selections from database: ${error}`
            );
          }
        } catch (error) {
          logger.error(
            `Failed to claim victory for challenge ${gameId}: ${error}`
          );
          ws.send(
            JSON.stringify({
              type: "claimVictoryFailed",
              message: "Failed to update challenge status.",
            })
          );
        }
      }
    } catch (error) {
      logger.error(`Error processing message: ${error}`);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to process message",
        })
      );
    }
  });

  ws.on("close", () => {
    for (const [userId, data] of onlineUsers.entries()) {
      if (data.ws === ws) {
        onlineUsers.delete(userId);
        logger.info(`User ${data.name} (${userId}) disconnected`);
        broadcastOnlineUsers();
        break;
      }
    }
    console.log("WebSocket connection closed");
  });
});

// Load winner selections from database on server startup
loadWinnerSelectionsFromDB();

logger.info(
  `WebSocket server is running on ws://localhost:${process.env.PORT || 8080}`
);
