---
name: canvas-comment
description: How to handle a canvas comment, a pull request comment that starts "New canvas comment", "Canvas reply" or "Canvas thread reopened" and ends with `<!-- canvas {"thread":…} -->`. Covers reading it with the canvas CLI, reproducing it, fixing it, answering on the canvas (never on GitHub), and keeping the person's data out of the repo. Use it whenever such a comment arrives.
---

# A canvas comment

The PR comment is a pointer: a thread code, and maybe a component and source file. Everything else (what the person
wrote, the page, the steps, what they typed, screenshots) is in the canvas, and may hold real people's data.

1. **Read.** `npx canvas show <code>`: the comments, the element (selector, component, `file:line`), the page, the
   build, the steps with typed values, console errors, failed requests, and the paths of the saved screenshots. Look at
   the screenshots (Read the files). A "Canvas thread deleted" comment needs nothing.
2. **Reproduce.** `npx canvas repro <code> --fictional --out <file>` writes a Playwright test that replays the steps
   with fake typed values and stops at a TODO. Run it against the app (`BASE_URL=http://localhost:5173 npx playwright
   test <file>`; the app needs `@playwright/test`) and see the problem.
3. **Fix** it in the source the thread names. Finish the repro's TODO with the assertion the comment asks for, and
   check it fails before the fix and passes after. Run the project's usual checks.
4. **Answer on the canvas**, never on GitHub: `npx canvas reply <code> "What changed, and where to see it"`. It shows
   on the pin in the app. Add `--resolve` when it's done (or `npx canvas resolve <code>`); leave it open when you've
   asked a question. A "Canvas reply" pointer means the person answered: `canvas show` again.

## Their data stays out of the repo

- Never copy names, emails, phones, typed values, page URLs, comment text or screenshots into commits, PR text, PR
  comments, tests, fixtures or logs. Describe a fix by its code ("the Save button in `PersonRow`"), not by its data.
- Commit a repro only as made with `--fictional`, and check it for real data before committing: its selectors, words
  and URLs come from the page. Swap any for fictional values (`Jordan Alvarez`, `@example.org`, `555-01xx`).
- Screenshots stay in the temp folder `canvas show` saved them to.
