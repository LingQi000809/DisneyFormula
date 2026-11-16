# Setup
## 1. Excerpts

Requires `numpy`, `soundfile` and ffmpeg (`brew install ffmpeg`).

```
cd ExploratoryExperiment/pilot
python3 prepare_stimuli.py
```

This cuts 8 s from each `Start_Timestamp` in `DisneyCorpus/audio_full/` and normalizes every excerpt to the same loudness (−18 LUFS by default). It then writes `excerpts_8s/`, `loudness_report.csv`, `excerpts_8s_anonymized/`, `clips.js` and the two files in `private/`.

**Titles.** Manually add a row to `song_titles.csv` only for a different name that should also count, such as an original-language title (`Without You` → "Tres Palabras").

**Title matching** (in `Code.gs`). An answer counts when, after cleanup, it is within the typo allowance of the title or a listed alternate.
- Cleanup ignores capitals, accents, punctuation, apostrophes, spaces and "the / a / an". It also reads "&" as "and", "wanna" as "want to" and "gonna" as "going to".
- The bracketed part of a title is optional, so "Part of Your World" counts for "Part of Your World (Reprise)".
- A film or artist added after `(`, ` - `, `:`, "from" or "by" is ignored, so "Reflection - Mulan" counts.
- Typos: titles of 3 letters or fewer must be exact. Titles of 4–7 letters allow 1 wrong letter. Longer titles allow about 1 per 5 letters. Two swapped letters count as one error.
- Partial titles and lyrics don't count unless you list them as alternates.

## 2. Sheet (use a personal Gmail account; GT accounts may block outside access)

- Create a blank Google Sheet, then go to **Extensions → Apps Script**. Paste in `Code.gs` and save.
- In the function dropdown next to **Run** at the top of the editor, choose **setup**, then click **Run**. The first time, choose **Review permissions →** your account **→ Advanced → Go to … → Allow**. Wait for *Execution completed* in the log.
- Switch back to the browser tab with the **Sheet** (not Apps Script). `setup` has created the tabs **Key, Settings, Participants, Trials** along the bottom. If you don't see them, reload the Sheet.
- Click the **Key** tab, go to **File → Import → Upload**, choose `private/key.csv`, and pick **Replace current sheet**. This replaces the tab that is selected, so make sure it's Key.
- Go to **Deploy → New deployment → Web app**. Set Execute as **Me** and access to **Anyone**, then copy the URL. It ends in `/exec`.

## 3. Connect

In `index.html`, replace `PASTE_YOUR_WEB_APP_URL_HERE` with that URL.

**Preview locally (optional)**
- In this folder, run `python3 -m http.server 8000` and open http://localhost:8000.
- Refresh the page after edits. Press Ctrl+C to stop the server.
- Submissions go to the real sheet, so delete those test rows afterwards.

## 4. GitHub Pages

The survey is served from a separate public repo, **`song-recognition-survey`**, at
`https://lingqi0809.github.io/song-recognition-survey/`. The repo name becomes the last part of the link, so rename both together if you want a different one. You keep working in DisneyFormula as usual. A GitHub Action (`.github/workflows/deploy-survey.yml`) copies `index.html`, `clips.js` and `excerpts_8s_anonymized/` to the site repo whenever you push changes to them. Nothing else from DisneyFormula is published, so DisneyFormula can stay private.

**One-time setup**

1. **Create the site repo.** On GitHub, go to **New repository**. Name it `song-recognition-survey`, make it **Public**, and tick **Add a README** so it has a `main` branch. Then, in that repo, go to **Settings → Pages** and set **Deploy from a branch → main / (root)**.
2. **Create a token** that lets DisneyFormula write to it. Go to GitHub **Settings** (your profile) → **Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Repository access: **Only select repositories → `song-recognition-survey`**
   - Permissions → Repository → **Contents: Read and write**
   - Choose an expiration date that covers the survey period, then copy the token.
3. **Store the token in DisneyFormula.** Open the DisneyFormula repo's **Settings → Secrets and variables → Actions → New repository secret**. Name it `SITE_DEPLOY_TOKEN` and paste the token.
4. **Push DisneyFormula:** `git add -A && git commit -m "Add pilot survey" && git push`.
5. Open DisneyFormula's **Actions** tab and wait for **Deploy survey site** to show a green check, which takes about 30 s. Pages needs another minute or so, then the survey is live at `https://lingqi0809.github.io/song-recognition-survey/`.

If DisneyFormula's own **Settings → Pages** is turned on from earlier, turn it off. Otherwise the survey is also reachable under the old long link.

**Updating the site:** edit, commit and push DisneyFormula as normal. The site updates by itself. To re-sync without changing anything, go to **Actions → Deploy survey site → Run workflow**.

If you name the site repo something else, change `SITE_REPO` at the top of `.github/workflows/deploy-survey.yml` to match.


## 5. Test

Take the survey once, check that the rows appear in the sheet, then delete your test rows.

## Later

- **Going from the demo to the full survey:** the page currently plays 3 random excerpts per person (`var DEMO_N = 3;` in `index.html`). Set it to `0` to use all excerpts. Delete the demo rows in **Participants** and **Trials** (keep the header row), then commit and push. The Action redeploys the site. Nothing else needs to change.

- **Scores are stored, not recalculated.** Each excerpt is scored once when it's saved (Trials → `correct`). Each participant's total and average time are written when they finish (Participants → `correct`, `avg_response_s`). The leaderboard only reads those Participants columns.
- To change the time limit, edit **Settings B1** (in seconds). To accept another name, add it to the **Key** tab, and also to `song_titles.csv` so the next import keeps it. **Then run Survey → Rescore everyone** (menu in the Sheet) so existing scores update.
- The leaderboard shows the top **Settings B2** entries (default 10). A participant ranked lower sees "…" and their own row and rank underneath.
- If you edit `Code.gs`, go to **Deploy → Manage deployments → Edit → New version**. If the update adds columns, run **setup** again once; it only rewrites the header rows and keeps your data.
- **Changing excerpts after launch:** re-run the script, re-import `key.csv`, and redeploy (step 4). Existing excerpts keep their `clip_…` IDs, which are read from `clip_map.csv`, so responses already collected stay valid. Don't delete `private/`.
- **Data:** each excerpt's response is saved to the Trials tab as soon as the participant clicks **Next excerpt**, so you keep partial data from people who quit early. Their `pid` has no row in Participants. Only finished participants appear on the leaderboard.
- **Analysis:** the Trials tab stores `clip_id`. Join it with `clip_map.csv` to get the song names.
