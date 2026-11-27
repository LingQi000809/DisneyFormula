# Setup
## 1. Excerpts

Requires `numpy`, `soundfile` and ffmpeg (`brew install ffmpeg`).

```
cd ExploratoryExperiment/pilot
python3 prepare_stimuli.py
```

This cuts 8 s from each `Start_Timestamp` in `stimuli_ballad_test_excerpts.csv`. Each song's set comes from the folder its audio is in: `DisneyCorpus/disney_full/` → **disney**, `DisneyCorpus/control_full/` → **control**. The CSV's Origin column isn't used. All excerpts from both sets are normalized to one common loudness (−18 LUFS by default). If any excerpt would clip, the target is lowered for all of them. The script then writes `excerpts_8s/disney/` and `excerpts_8s/control/`, `loudness_report.csv`, `excerpts_8s_anonymized/` (both sets mixed), `clips.js` and the two files in `private/`. A song name must exist in only one of the two folders.

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
- Switch back to the browser tab with the **Sheet** (not Apps Script). `setup` has created the tabs **Key, Participants, Trials** along the bottom. If you don't see them, reload the Sheet.
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

- **Going from the demo to the full survey:** `var DEMO_N` in `index.html` sets how many random excerpts each person hears (currently `0`, all 110). Set it to `0` to use all excerpts, or to the number each person should hear, and set `var EST_MINUTES` just below it to the length shown on the welcome page (about 15 s per excerpt plus 1 minute). Delete the demo rows in **Participants** and **Trials** (keep the header row; rows saved before the raffle update have a different column layout, so delete those in any case), then commit and push. The Action redeploys the site. Nothing else needs to change.

- **Screening.** The survey starts with background questions. A participant continues only if they are in the US, 18 or older, and their Disney-film and musical answers add up to at least 3 (a range like "3–5" counts as its lower number). This is the same rule as the Qualtrics branch. Anyone else sees a neutral thank-you page and is logged in Participants with `status` = `screened_out`. The page never mentions screening or its criteria. The browser remembers a screened-out visit, so reloading doesn't offer a second try. To test again yourself, open the link with `?reset` at the end.
- **Correct answers.** Each excerpt is marked correct once, when it's saved (Trials → `correct`), Participants → `correct` (each person's total) stays blank until you run **Survey → Rescore everyone**, which fills it in for everyone at once. There is no time limit; `response_ms` and `submit_ms` are stored, so apply any cutoff in the analysis. To accept another name, add it to the **Key** tab and to `song_titles.csv` (so the next import keeps it), then run **Survey → Rescore everyone**.
- **Raffle.** The raffle question and email come first, before the background questions, so screened-out rows keep the email too. Participants → `raffle` is TRUE for each valid entry: the person completed the survey, gave an email, and that email doesn't appear in any earlier row (`duplicate`), including a screened-out one. A retry after being screened out therefore doesn't count. Emails must match exactly (capitals are ignored). To exclude an entry, for example for careless answers, set its `raffle` cell to FALSE. When the survey closes, run **Survey → Draw raffle winner**. The winner goes to a **Winners** tab, and each draw replaces the previous one.
- If you edit `Code.gs`, go to **Deploy → Manage deployments → Edit → New version**. If the update adds columns, run **setup** again once; it only rewrites the header rows and keeps your data.
- **Changing excerpts after launch:** re-run the script, re-import `key.csv`, and redeploy (step 4). Existing excerpts keep their `clip_…` IDs, which are read from `clip_map.csv`, so responses already collected stay valid. Don't delete `private/`.
- **Resume.** After the background questions and after every excerpt, the page saves its place in the participant's browser. Reopening the same link on the same device shows "Welcome back" and continues at the next unanswered excerpt, with the same `pid` and excerpt order. This doesn't work across devices or in private windows, and saved progress is forgotten after 72 hours. `?reset` also clears saved progress when you test.
- **Data:** each excerpt's response is saved to the Trials tab as soon as the participant clicks **Next excerpt**, so you keep partial data from people who quit early. Their `pid` has no row in Participants unless they come back and finish. Only finished participants can enter the raffle.
- **Analysis:** the Trials tab stores `clip_id`. Join it with `clip_map.csv` to get the set (`disney` / `control`) and song name.
