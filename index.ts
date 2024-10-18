import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

// Initialize express app
const app = express();

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket Server
const wss = new WebSocketServer({ server });

// List of users and a map to track socket IDs
const users = ['prajjwal', 'yash'];
const userSocketMap = new Map(); // To store user names and their WebSocket objects

// Function to send messages
const sendMessage = (ws:any, message:any) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

// Set up the WebSocket connection
wss.on('connection', (ws, req) => {
  // Get the user's name from query parameters
  
  const params = new URLSearchParams(req?.url?.split('?')[1]);
  const name = params.get('name');
  
  if (!name || !users.includes(name)) {
    sendMessage(ws, { error: 'Invalid user' });
    ws.close();
    return;
  }

  console.log(`${name} has joined`);

  // Store the user's WebSocket object
  userSocketMap.set(name, ws);

  // Handle incoming messages
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'sendChallenge') {
      console.log(data);

      // Look up the opponent's WebSocket in the map
      const opponentWs = userSocketMap.get(data.data.opponent);
      
      if (opponentWs) {
        sendMessage(opponentWs, {
          type: 'challengeReceived',
          data: data,
        });
        console.log(data)
        console.log(`Challenge sent to ${data.data.opponent}`);
      } else {
        console.log(`${data.opponent} is not connected`);
        sendMessage(ws, { error: `${data.opponent} is not connected` });
      }
    }

    if (data.type === 'acceptChallenge') {
      console.log('challenge accepted by opponent')
      wss.clients.forEach((client) => {
        sendMessage(client, { type: 'gameStarted' });
      });
    }

    if (data.type === 'claimWin') {
      console.log(data.claimedBy)
      wss.clients.forEach((client) => {
        sendMessage(client, { type: 'winClaimed',claimedBy:data.claimedBy });
      });
    }

    if (data.type === 'challengeDecision') {
      wss.clients.forEach((client) => {
        sendMessage(client, { type: 'decisionChallenged' });
      });
    }
  });

  // Handle disconnection
  ws.on('close', () => {
    console.log(`${name} has disconnected`);
    userSocketMap.delete(name); // Remove the user from the socket map
  });
});

// Express route to send the users array
app.get('/users', (req, res) => {
  res.json(users); // Send the users array as JSON
});

// Start the server
const port = 3001;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
