---
name: mm2.bet sign-in flow
description: External sign-in behavior that affects the mm2.bet chat bot.
---

The mm2.bet chat page can require two clicks: first the visible “Sign in with Discord to chat” control, then “Continue with Discord” in the sign-in dialog. The OAuth URL is generated live and includes a temporary state value, so it must never be hardcoded.

**Why:** The site may leave the browser on the home page if the dialog step is skipped, and a copied OAuth URL can expire or be single-use.

**How to apply:** When maintaining the chat bot login, detect the direct chat sign-in control, allow the dialog to render, click the Discord continuation control, and capture the current redirect from the browser.