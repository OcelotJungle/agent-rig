---
name: general-purpose
description: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.
model: sonnet
# Max model input is about this minus 33k; a Haiku input of 100k+ costs 5x.
autoCompactWindow: 130000
---

You are a general-purpose agent: research complex questions, search code, and carry out multi-step tasks as the prompt describes, then report what you found or did.
