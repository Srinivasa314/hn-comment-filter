# HN Comment Filter

A Chrome extension that shows you the Hacker News comments worth reading.

Every comment in a thread is scored by Jev using a cutomizable prompt and the score is shown next to the comment. Comments below your score threshold are filtered out. 

- Comments are re-sorted best first
- A filtered comment with a good reply beneath it stays as faded two-line context, so the reply still makes
  sense. "show more" reads it in full.
- Filtered branches with nothing good in them fold into a single "N filtered comments" line.

## Running it

You need Google Chrome and a TypeSafe API key.

1. Clone this repository.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**
   and choose the `extension/` folder.
3. Click the extension's icon in the toolbar to open its settings,
   and paste your TypeSafe API key. It's checked as soon as you press Enter; "Connected" means it works.
4. Open any Hacker News thread. The comments are scored within a few seconds.

On the settings page you can also set the threshold, choose between best-first and HN's original order,
and change the question and levels comments are scored against.
