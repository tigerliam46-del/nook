# Nook

A small self-hosted chat app: accounts, servers, channels, invite codes, live messages, typing indicators, online/offline members and unread dots.

## Run it

You need Node.js 18 or newer.

```
npm install
npm start
```

Then open http://localhost:3000. Create an account, make a server, and copy the invite code with the Invite button. Open a second browser (or a private window), make another account, and join with that code to see messages arrive live.

## Settings

- `PORT` changes the port (default 3000).
- `JWT_SECRET` sets the login-token key. If you leave it unset, one is generated and saved in `data/jwt.secret`.

Data lives in `data/nook.db` (SQLite). Back that folder up.

## Putting it on your domain

Run it on a VPS (or a host like Render or Railway that runs Node apps) and put it behind HTTPS, for example with Caddy or nginx. Plain shared web hosting can't run it because it needs a long-running Node process for WebSockets.

## Files

- `server.js` backend: REST API, SQLite, Socket.IO
- `public/index.html`, `style.css`, `app.js` the web app

## Ideas for next steps

Direct messages, image uploads, roles and permissions, message editing, loading older history on scroll (the API already supports `?before=<messageId>`), and voice chat via WebRTC.

## Voice chat

Voice channels use WebRTC straight between browsers (up to 8 people per channel). Browsers only allow microphones on `https://` pages or `localhost`, so put the app behind HTTPS when you host it. It uses a public STUN server; a few strict networks may need a TURN server added in `RTC_CONFIG` in `public/app.js`.

## Security

Passwords use bcrypt (cost 12). Responses carry a strict Content-Security-Policy and other protective headers, login and API requests are rate limited, uploads are checked (pictures must be real JPEGs under 60 KB), and every action is permission-checked on the server. Set `JWT_SECRET`, serve over HTTPS, and set `TRUST_PROXY=1` if you sit behind a reverse proxy such as Caddy or nginx.

## Backups

Your accounts, servers and messages live in `data/nook.db`. Nook saves a safe copy into `backups/` every time it starts and once a day, keeping the newest 14. You can make one yourself any time with `npm run backup`.

To restore: stop Nook, copy the backup you want over `data/nook.db`, delete `data/nook.db-wal` and `data/nook.db-shm` if they exist, then start Nook again.

Copy the `backups/` folder somewhere else now and then (another drive or cloud storage), because a backup on the same machine does not protect you if that machine is lost. The `.gitignore` keeps `data/`, `backups/` and `node_modules/` out of Git.

## Deploy on Fly.io

Needs the `fly` command-line tool and a Fly account (new accounts pay as they go, so a card is required). Nook must run as one machine with one volume.

```
fly auth login
fly launch --copy-config --no-deploy      # pick a unique app name, region London (lhr), no databases
fly volumes create nook_data --size 1 --region lhr
fly deploy --ha=false
```

Then attach your domain: `fly certs add yourdomain.com`, add the A and AAAA records it prints at your domain provider, and run `fly certs check yourdomain.com` until it is ready. Nook's own daily backups are saved inside the volume (`data/backups`).
