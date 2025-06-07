# nighthub-backend

NightHub Backend
This is the backend repository for NightHub, an anonymous 1-on-1 chat platform built with Node.js, Express, and Socket.IO.
Prerequisites

Node.js (v18 or higher)
GitHub account
GitHub Codespaces (optional for development)
Render.com account for deployment

Setup in GitHub Codespaces

Create the Repository:

Create a new repository named nighthub-backend on GitHub.
In Codespaces, open a terminal and run:mkdir nighthub-backend
cd nighthub-backend
git init
git remote add origin https://github.com/<your-username>/nighthub-backend.git




Copy Files:

Copy all provided files (server.js, package.json) into the nighthub-backend directory.


Install Dependencies:
npm install


Run Locally:
npm run dev


The server runs on http://localhost:3001 in Codespaces.


Commit and Push:
git add .
git commit -m "Initial NightHub backend setup"
git push -u origin main



Deployment on Render.com

Create a new Web Service on Render.com.
Connect the nighthub-backend GitHub repository.
Configure:
Build Command: npm install
Start Command: npm start
Environment Variables:
None required (CORS hardcoded for https://nighthub.io).




Deploy the service as nighthub-backend.onrender.com.

Development Notes

Uses Socket.IO for real-time chat with NSFW/non-NSFW pairing logic.
Includes Helmet and CORS for basic security.
The codebase is modular for future feature additions.
Rooms are cleaned up automatically on disconnect.

Folder Structure
nighthub-backend/
├── server.js
├── package.json
├── README.md

For issues, contact support@nighthub.io.
