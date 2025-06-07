import WebSocket, { WebSocketServer } from "ws";
import prisma from "./db";
import { logger } from "./utils/logger";
import type { $Enums } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

const wss = new WebSocketServer({ port: 8080 });
const onlineUsers = new Map();
const startChallengeMap = new Map();

const winnerSelections = new Map(); // Format: Map<gameId, Map<playerId, selectedWinner>>

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

function broadcastToChallengePlayers(gameId, message) {
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
  inviteeId: string;
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
  updateState:{
    id: string;
    creatorId: string;
    inviteeId: string;
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
  username:any
) {
  const usersInChallenge = [updateState.creatorId, updateState.inviteeId]
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
  inviteeId: string;
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
    .map((username) => onlineUsers.get(username))
    .filter((ws) => ws);

  const message = JSON.stringify({ type: "challengeCreated", newChallenge });

  usersInChallenge.forEach((ws) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

wss.on("connection", (ws:WebSocket) => {
  logger.info("A new client connected");
  ws.on("error", console.error);

  ws.on("message", async (message:string) => {
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

        // Initialize the game's selections if it doesn't exist
        if (!winnerSelections.has(gameId)) {
          winnerSelections.set(gameId, new Map());
        }

        // Store the selection
        const gameSelections = winnerSelections.get(gameId);
        gameSelections.set(playerId, selectedWinner);

        // Convert Map to object for JSON serialization
        const selectionsObj = {};
        gameSelections.forEach((winner, player) => {
          selectionsObj[player] = winner;
        });

        // Broadcast the updated selections to both players
        broadcastToChallengePlayers(gameId, {
          type: "winnerSelectionUpdate",
          gameId,
          playerId,
          selectedWinner,
          allSelections: selectionsObj,
        });

        logger.info(`Winner selection broadcasted for game ${gameId}`);
      }

      // Handle request for all winner selections
      if (userInfo.type === "getWinnerSelections") {
        const allSelections = {};
        winnerSelections.forEach((gameSelections, gameId) => {
          const selectionsObj = {};
          gameSelections.forEach((winner, player) => {
            selectionsObj[player] = winner;
          });
          allSelections[gameId] = selectionsObj;
        });

        ws.send(
          JSON.stringify({
            type: "allWinnerSelections",
            selections: allSelections,
          })
        );
      }

      if (userInfo.type === "createChallenge") {
        const {
          creatorUsername,
          coins,
          xp,
          opponentUsername,
          game,
          description,
          rules,
        } = userInfo;
        const newChallenge = await prisma.challenge.create({
          data: {
            game,
            creatorId: creatorUsername,
            inviteeId: opponentUsername,
            coins,
            xp,
            status: "PENDING",
            description: description || null,
            rules: rules || { timeLimit: "30 minutes", maxMoves: 100 },
            expiresAt: new Date(new Date().getTime() + 24 * 60 * 60 * 1000),
          },
        });
        broadcastNewChallenge(newChallenge);
        logger.info(
          `A new challenge is created between ${creatorUsername} and ${opponentUsername}`
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
          ws.send(
            JSON.stringify({
              type: "claimVictoryFailed",
              message:
                "No winner selections found. Both players must select a winner first.",
            })
          );
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

        // Check if both players have made selections and they agree
        if (!creatorSelection || !inviteeSelection) {
          ws.send(
            JSON.stringify({
              type: "claimVictoryFailed",
              message:
                "Both players must select a winner before claiming victory.",
            })
          );
          return;
        }

        if (creatorSelection !== inviteeSelection) {
          ws.send(
            JSON.stringify({
              type: "claimVictoryFailed",
              message:
                "Players disagree on the winner. Please discuss and reselect.",
            })
          );
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

          // Clean up winner selections for this game
          winnerSelections.delete(gameId);
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

// console.log("WebSocket server is running on ws://localhost:8080");
