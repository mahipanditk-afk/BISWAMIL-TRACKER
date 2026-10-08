# Biswamil Movement Log (Render version)

Realtime movement log for the fest. Installable on Android and iPhone from the browser (PWA).

## Deploy on Render
1. Put these files in a GitHub repository (do not upload node_modules).
2. Render dashboard: New > Postgres. Copy its **Internal Database URL**.
3. New > Web Service > pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Starter (a Free instance sleeps after 15 minutes idle)
   - Environment variables:
     - `VOL_CODE`  access code for volunteers
     - `HQ_CODE`   different access code for HQ (full access)
     - `DATABASE_URL`  the Internal Database URL from step 2
4. Deploy. In the logs you should see `Storage: postgres`.
5. Open the onrender.com address, enter a code, done.

Run only ONE instance (do not scale to 2+). To change a code, edit the env var and redeploy.

## Local test
`VOL_CODE=a HQ_CODE=b npm start` then open http://localhost:3000 (stores data in data.json).
