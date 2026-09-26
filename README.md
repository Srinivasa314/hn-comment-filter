# HN Comment Filter

A Chrome extension that shows you the Hacker News comments worth reading.

Every comment in a thread is scored from 0 to 100 by [TypeSafe](https://typesafe.ai)'s Jev model, using a
question you can edit ("How worth reading is this comment…?" by default). Comments below your threshold
are filtered without breaking the conversation:

- A filtered comment with a good reply beneath it stays as faded two-line context, so the reply still makes
  sense. "show more" reads it in full.
- Filtered branches with nothing good in them fold into a single "N filtered comments" line.
- Comments are re-sorted best first, and replies always stay under the comment they answer.

Each comment gets a score badge; hover it to see why. Scores are cached, so revisiting a thread is instant.

## Running it

You need Google Chrome and a TypeSafe API key. Scoring costs about $0.01 per 1,000 comments.

1. Clone this repository.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**
   and choose the `extension/` folder.
3. Click the extension's icon in the toolbar (it may be under the puzzle-piece menu) to open its settings,
   and paste your TypeSafe API key. It's checked as soon as you press Enter; "Connected" means it works.
4. Open any Hacker News thread. The comments are scored within a few seconds.

On the settings page you can also set the threshold, choose between best-first and HN's original order,
and change the question and levels comments are scored against. The toolbar above the comments on each
thread turns filtering on or off.

After pulling changes, click the reload icon on the extension's card in `chrome://extensions`.
