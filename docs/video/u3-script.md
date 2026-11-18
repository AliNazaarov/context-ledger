# The 60-second CTM demo: shot list and voice-over

*Card U3, 2026-11-17. Everything shown is synthetic: the Orbit demo transcripts in `demo/` and the console's bundled recording. Nothing personal appears on screen.*

## What is ready and what a person does

- **Raw console footage:** `node demo/record-console.mjs` records it. The script starts a ledger on a throwaway database, plays `/console/?demo` to the end, clicks one decision, and saves `test-results/u3/console-demo.webm` (1280×720, about 42 s). It is not committed: re-record it from the branch you edit on.
- **A person records** the terminal shots and the voice-over, then cuts the pieces to the timings below. That needs a microphone and a screen recorder.

## Shots

| Time | Shot | On screen | Voice-over |
| --- | --- | --- | --- |
| 0:00–0:05 | Title | "CTM", and the line "They move conversations. We move evidence." Pip once U2 is merged. | "Two coding agents, one project, and no memory between them." |
| 0:05–0:15 | Terminal | `npm start`, then `npm run ledger -- install` connecting Claude Code and Codex (card G8; before it is merged, the two `mcp add` commands from the README) | "CTM is a ledger on your own machine. One command connects Claude Code and Codex to it." |
| 0:15–0:42 | Console footage 0:00–0:27 | The empty office, then Leo's Claude Code and Ali's Codex publish. Their cards pop into the ledger, flash lines run from each room, and dashed lines link their questions and answers. | "As the agents work, each publishes what it decided, with the transcript line behind every fact. They link to each other's work: Ali asks which port, Leo's decision answers." |
| 0:42–0:54 | Console footage 0:30–0:42 | The finished graph; a click on "The ledger stays on port 4317" opens the proof, with lines L27 and L28 highlighted | "One click shows the proof: the exact lines where the plan changed." |
| 0:54–1:00 | Console footage, numbers strip | Hand-offs today and tokens saved, which the console labels as an estimate | "Your transcripts never leave your machine. Only the cited summary goes to the agent you pick." |

## Rules for the cut

- Keep the console's own label "estimate" visible whenever the tokens-saved number is on screen, and say no figure the console does not show.
- Use only the synthetic demo. Never record a real transcript, a real home folder or a real terminal history.
- Speak at an easy pace: the voice-over is about 110 words, which fits 60 seconds with room to breathe.
- Captions: burn in the voice-over text, so the video works with the sound off.
