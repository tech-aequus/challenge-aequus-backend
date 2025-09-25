import WebSocket, { WebSocketServer } from "ws";
import prisma from "./db";
import { logger } from "./utils/logger";
import type { $Enums } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

const wss = new WebSocketServer({ port: 8080 });
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

function broadcastToChallengePlayers(gameId: string, message: any) {
  // Get challenge details to find both players
  prisma.challenge
    .findUnique({
      where: { id: gameId },
      select: { creatorId: true, inviteeId: true },
    })
    .then((challenge) => {
      if (challenge) {
        const players = [challenge.creatorId, challenge.inviteeId];
        players.forEach((playerId) => {
          const playerWs = onlineUsers.get(playerId);
          if (playerWs && playerWs.readyState === WebSocket.OPEN) {
            playerWs.send(JSON.stringify(message));
          }
        });
      }
    })
    .catch((error) => {
      logger.error(`Error broadcasting to challenge players: ${error}`);
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
    .map((username) => onlineUsers.get(username))
    .filter((ws) => ws);

  const message = JSON.stringify({
    type: "challengeAccepted",
    updatedChallenge,
  });
  usersInChallenge.forEach((ws) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

function broadcastGameStateUpdate(
  updateState: {
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
  },
  username: any
) {
  const usersInChallenge = [updateState.creatorId, updateState.inviteeId]
    .filter(Boolean)
    .map((username) => onlineUsers.get(username))
    .filter((ws) => ws);
  const message = JSON.stringify({
    type: `challengeStartedBy`,
    updateState,
  });
  usersInChallenge.forEach((ws) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
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
    .map((username) => onlineUsers.get(username))
    .filter((ws) => ws);

  const message = JSON.stringify({ type: "challengeCreated", newChallenge });

  usersInChallenge.forEach((ws) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
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
  const message = JSON.stringify({ type: "openChallengeCreated", newChallenge });

  // Broadcast to all online users
  onlineUsers.forEach((ws) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
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

        if (userInfo.online || userExists) {
          onlineUsers.set(userInfo.username, ws);
          logger.info(`${userInfo.username} is now online`);
          broadcastOnlineUsers();
        } else {
          logger.info(`${userInfo.username} does not exist in the database`);
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
                playerId: playerId
              }
            },
            create: {
              challengeId: gameId,
              playerId: playerId,
              selectedWinner: selectedWinner
            },
            update: {
              selectedWinner: selectedWinner,
              updatedAt: new Date()
            }
          });

          // Initialize the game's selections if it doesn't exist
          if (!winnerSelections.has(gameId)) {
            winnerSelections.set(gameId, new Map());
          }

          // Store the selection in memory cache
          const gameSelections = winnerSelections.get(gameId);
          gameSelections.set(playerId, selectedWinner);

          // Convert Map to object for JSON serialization
          const selectionsObj: Record<string, string> = {};
          gameSelections.forEach((winner: string, player: string) => {
            selectionsObj[player] = winner;
          });

          logger.info(
            `Current selections for game ${gameId}:`,
            JSON.stringify(selectionsObj)
          );

          // Broadcast the updated selections to both players
          broadcastToChallengePlayers(gameId, {
            type: "winnerSelectionUpdate",
            gameId,
            playerId,
            selectedWinner,
            allSelections: selectionsObj,
          });

          logger.info(`Winner selection saved to DB and broadcasted for game ${gameId}`);
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
                select: { status: true }
              }
            }
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

      if (userInfo.type === "createChallenge") {
        const {
          creatorUsername,
          coins,
          xp,
          opponentUsername, // Legacy field for backward compatibility
          inviteeId, // New unified field
          game,
          description,
          rules,
          isOpen = false, // New unified field
          status, // All challenges use PENDING status
        } = userInfo;

        // Use the new unified approach: inviteeId for target user, isOpen for open challenges
        const targetInvitee = isOpen ? null : (inviteeId || opponentUsername);
        const challengeStatus = "PENDING"; // All challenges start as PENDING

        const newChallenge = await prisma.challenge.create({
          data: {
            game,
            creatorId: creatorUsername,
            inviteeId: targetInvitee,
            coins,
            xp,
            status: challengeStatus,
            description: description || null,
            rules: rules || { timeLimit: "30 minutes", maxMoves: 100 },
            isOpen: isOpen,
            expiresAt: new Date(new Date().getTime() + 24 * 60 * 60 * 1000),
          },
        });        // For open challenges, broadcast to all online users. For private challenges, broadcast to specific users
        if (isOpen) {
          broadcastOpenChallenge(newChallenge);
        } else {
          broadcastNewChallenge(newChallenge);
        }

        logger.info(
          isOpen
            ? `A new open challenge is created by ${creatorUsername} for ${game}`
            : `A new challenge is created between ${creatorUsername} and ${targetInvitee}`
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
        const { gameId, username } = userInfo;
        try {
          // Check if challenge exists and is open
          const challenge = await prisma.challenge.findUnique({
            where: { id: gameId },
            select: { status: true, isOpen: true, creatorId: true, inviteeId: true },
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

          if (challenge.creatorId === username) {
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

          // Update challenge with the joining user and change status to ACCEPTED
          const updatedChallenge = await prisma.challenge.update({
            where: { id: gameId },
            data: {
              inviteeId: username,
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
        const { gameId, creatorUsername, opponentUsername, username } =
          userInfo;
        logger.info(
          `Start challenge requested by ${username} for gameId ${gameId}`
        );

        const isUserOnline =
          onlineUsers.has(creatorUsername) && onlineUsers.has(opponentUsername);
        logger.info(`Is user online? ${isUserOnline}`);

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

        const challenge = await prisma.challenge.findUnique({
          where: { id: gameId },
          select: { status: true },
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

        const currentStatus = challenge.status;
        logger.info(`Current challenge status: ${currentStatus}`);

        if (!startChallengeMap.has(gameId)) {
          startChallengeMap.set(gameId, {
            creatorStarted: false,
            opponentStarted: false,
          });
        }

        const challengeState = startChallengeMap.get(gameId);

        if (currentStatus === "STARTING") {
          if (username === creatorUsername && challengeState.creatorStarted) {
            ws.send(
              JSON.stringify({
                type: "failedToStartChallenge",
                message: "You already started the challenge",
              })
            );
            logger.info(`${username} has already started the challenge`);
            return;
          }
          if (username === opponentUsername && challengeState.opponentStarted) {
            ws.send(
              JSON.stringify({
                type: "failedToStartChallenge",
                message: "You already started the challenge",
              })
            );
            logger.info(`${username} has already started the challenge`);
            return;
          }
          if (username === creatorUsername) {
            challengeState.creatorStarted = true;
          } else if (username === opponentUsername) {
            challengeState.opponentStarted = true;
          }

          logger.info(`Added ${username} to usersStarted map`);
          if (challengeState.creatorStarted && challengeState.opponentStarted) {
            logger.info(
              `Both users started the challenge, setting to IN_PROGRESS`
            );

            const updatedChallenge = await prisma.challenge.update({
              where: { id: gameId },
              data: { status: "IN_PROGRESS" },
            });

            broadcastGameStateUpdate(updatedChallenge, username);
            startChallengeMap.delete(gameId);
          }
        } else if (currentStatus === "ACCEPTED") {
          logger.info(`Challenge is in ACCEPTED state, moving to STARTING`);

          const updatedChallenge = await prisma.challenge.update({
            where: { id: gameId },
            data: { status: "STARTING" },
          });

          if (username === creatorUsername) {
            challengeState.creatorStarted = true;
          } else if (username === opponentUsername) {
            challengeState.opponentStarted = true;
          }
          logger.info(`Added ${username} to usersStarted map`);

          broadcastGameStateUpdate(updatedChallenge, username);
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

            const creatorWs = onlineUsers.get(challenge.creatorId);
            const inviteeWs = onlineUsers.get(challenge.inviteeId);

            if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
              creatorWs.send(noSelectionsMessage);
            }
            if (inviteeWs && inviteeWs.readyState === WebSocket.OPEN) {
              inviteeWs.send(noSelectionsMessage);
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

          onlineUsers.get(updatedChallenge.creatorId)?.send(message);
          onlineUsers.get(updatedChallenge.inviteeId)?.send(message);

          // Clean up winner selections for this game from both memory and database
          winnerSelections.delete(gameId);

          try {
            await prisma.winnerSelection.deleteMany({
              where: { challengeId: gameId }
            });
            logger.info(`Cleaned up winner selections for completed challenge ${gameId}`);
          } catch (error) {
            logger.error(`Failed to clean up winner selections from database: ${error}`);
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
    for (const [username, client] of onlineUsers.entries()) {
      if (client === ws) {
        onlineUsers.delete(username);
        logger.info(`${username} disconnected`);
        broadcastOnlineUsers();
        break;
      }
    }
    console.log("WebSocket connection closed");
  });
});

// Load winner selections from database on server startup
loadWinnerSelectionsFromDB();

logger.info("WebSocket server is running on ws://localhost:8081");
