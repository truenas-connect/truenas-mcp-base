Please review the changes and provide comprehensive feedback.

Focus on:
- Code quality and best practices
- Maintainability, good architecture design and patterns
- Adherence to project conventions
- Potential bugs or issues
- Performance considerations
- Security implications

This is the shared core TypeScript library for TrueNAS MCP: the tool catalog,
system registry, safety model (plan/confirm, roles), and multi-system fan-out
used by both the standalone community server and the TrueNAS Connect browser
adapter. Pay particular attention to:
- Safety invariants: mutating tools must never execute without a valid,
  single-use confirmation token bound to the exact tool + arguments + target
  systems; irreversibly destructive operations must stay out of the catalog;
  the advertised tool list must respect role filtering.
- No environment assumptions: the core must not touch the filesystem, process,
  network APIs, or DOM directly — everything environment-specific enters
  through the injected interfaces (CredentialProvider, ConfirmationGate,
  AuditSink). It must run in both Node and the browser.
- Credential isolation: no shared state between registered systems; credentials
  must never appear in results, plans, or audit events.
- Type safety: avoid `any`, prefer precise types, and ensure generics are used
  correctly.
- Public API surface: exported types, functions, and method signatures are
  contracts — watch for breaking changes, inconsistent naming, and missing or
  misleading JSDoc.
- Async correctness: unhandled promise rejections, missing `await`, and race
  conditions — especially in the fan-out and executor paths.
- Resource lifecycle: API clients, subscriptions, and listeners should be
  cleaned up and not leak.

Do not provide:
- summary of what PR does
- list of steps you took to review
- numeric rating or score

When describing positive aspects of the PR, just mention them briefly in one - three sentences.

Ignore small nit-picky issues like formatting or style unless they significantly impact readability.

Provide constructive feedback with specific suggestions for improvement.
Use inline comments to highlight specific areas of concern.

Some common pitfalls to watch for:
- Fixing an issue in a specific place without considering other places or overall architecture.
- Leaving in unused code.
- Missing or inadequate test coverage for new behavior.
- Writing tests that interact with methods that should be private or protected.

Use an enthusiastic and positive tone, you can use some emojis.

Keep review brief and focused:
- do not repeat yourself
- keep overall assessment concise (one sentence)
