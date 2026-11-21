# Telebee

A Chrome MV3 extension for room chat, camera/mic video chat, and playback synchronization on streaming websites.

## Run

Copy `.env.example` to `.env` and add your ngrok authentication token:

```bash
cp .env.example .env
```

For macOS, double-click `start-server.command`. For Windows, double-click
`start-server.bat`.

### macOS

Double-click `start.command`, or run:

```bash
chmod +x start.command
./start.command
```

### Windows

Double-click `start.bat`, or run PowerShell:

```powershell
.\start.ps1
```

Both launchers check for Node.js and npm, install dependencies, and start the server.

### Start with an internet tunnel

Install ngrok, authenticate it once, then start:

```bash
npm start -- --ngrok
```

The script prints the public `wss://` URL to enter in the client extension.

To use the ngrok reserved domain:

```bash
npm start -- --ngrok --ngrok-url=telebee.ngrok-free.dev
```

### Manual start

Start the local signaling server:

   ```bash
   npm install
   npm run server
   ```

2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.

3. Select this project folder.

4. Open `https://koddo.to/`, click the Telebee extension, and open the side panel.

5. Everyone in the room enters the same room code. Camera/microphone access is optional.
   The 6-character code joins automatically. A client automatically opens the host's current
   movie URL and starts at the synchronized playback position.

## Notes

- For internet use, deploy `server.js` to a host with a public `https://` domain and set the
  Telebee server field to `wss://YOUR-DOMAIN`.
- For local/LAN use, set the server field to `ws://SERVER-IP:3001`.
- Keep `server.js` running while the extension is used.
- Playback sync looks for the first `<video>` element on the active page.
- The room currently supports text chat and a mesh WebRTC video call for a small group.
