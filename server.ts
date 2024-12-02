import WebSocket, { WebSocketServer } from "ws";
import prisma from "./db";
import { logger } from "./utils/logger";
import type { $Enums } from "@prisma/client";
import type { JsonValue } from "@prisma/client/runtime/library";

const wss = new WebSocketServer({ port: 8080 });
const onlineUsers = new Map<string, WebSocket>();
const startChallengeMap = new Map<
  string,
  { creatorStarted: boolean; opponentStarted: boolean }
>();

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

function broadcastChallengeUpdate(updatedChallenge: {
  id: string;
  creatorId: string;
  inviteeId: string;
  status: $Enums.ChallengeStatus;
  game: string;
  description: string | null;
  coins: number;
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
  updateState: {
    id: string;
    creatorId: string;
    inviteeId: string;
    status: $Enums.ChallengeStatus;
    game: string;
    description: string | null;
    coins: number;
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

wss.on("connection", (ws: WebSocket) => {
  logger.info("A new client connected");
  ws.on("error", console.error);

  ws.on("message", async (message: string) => {
    
    const userInfo = JSON.parse(message);
    console.log(userInfo)
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

      console.log("Received message: %s", message);
    }

    if (userInfo.type === "createChallenge") {
      const {
        creatorUsername,
        coins,
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
      const { gameId, creatorUsername, opponentUsername, username } = userInfo;
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

      const challengeState = startChallengeMap.get(gameId)!;

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
          startChallengeMap.delete(gameId); // Clean up the map
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
      try {
        const updatedChallenge = await prisma.challenge.update({
          where: { id: gameId },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            winnerId: winnerUsername, 
          },
        });

        logger.info(
          `Challenge ${gameId} status updated to COMPLETED by ${winnerUsername}`
        );

        const message = JSON.stringify({
          type: "challengeCompleted",
          updatedChallenge,
        });

        onlineUsers.get(updatedChallenge.creatorId)?.send(message);
        onlineUsers.get(updatedChallenge.inviteeId)?.send(message);
      } catch (error) {
        logger.error(
          `Failed to claim victory for challenge ${gameId}: ${error}`
        );
      }
    }
  });

  ws.on("close", () => {
    for (let [username, client] of onlineUsers.entries()) {
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

console.log("WebSocket server is running on ws://localhost:8080");
