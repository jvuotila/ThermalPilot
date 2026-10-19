# AGENTS.md

# Code Quality and Maintainability Guidelines

This project is a Home Assistant custom integration using Python,
JavaScript, and HTML.

The primary goal is to produce reliable, readable, and maintainable
code that human developers can easily understand, debug, and extend.

Code must be written for human maintainers, not just for execution
or to satisfy automated tests.

Always prioritize clarity, simplicity, and consistency over
cleverness, brevity, or unnecessary abstraction.

---

## 1. Core Principles

Follow these principles when writing or modifying code:

- Prioritize readability over cleverness.
- Prefer simple, explicit solutions.
- Follow existing project conventions.
- Avoid unnecessary abstractions and indirection.
- Avoid overengineering and speculative generalization.
- Use descriptive and meaningful names.
- Keep functions focused on a clear responsibility.
- Prefer straightforward control flow.
- Minimize nesting using early returns where appropriate.
- Avoid unnecessary dependencies.
- Do not introduce design patterns without a clear benefit.
- Do not optimize for fewer lines of code.
- Avoid premature optimization.
- Keep related logic together when it improves readability.

The simplest solution that correctly solves the problem is
usually the preferred solution.

---

## 2. Human Readability

Code must be understandable without requiring AI-generated
explanations.

### Naming

- Use descriptive variable, function, class, and method names.
- Names should communicate intent rather than implementation details.
- Avoid abbreviations unless they are widely understood.
- Avoid single-letter variables except for trivial loop indices.
- Use consistent terminology throughout the project.

### Functions and Methods

- Each function should have a clear purpose.
- Keep functions reasonably small, but do not split them
  into trivial helper functions unnecessarily.
- Avoid functions that merely forward arguments without
  adding meaningful behavior.
- Prefer explicit control flow over clever expressions.
- Avoid deeply nested conditions.
- Use early returns when they simplify the logic.

### Comments

- Comments should explain WHY something is done.
- Avoid comments that merely repeat what the code does.
- Document non-obvious behavior, constraints, and workarounds.
- Remove outdated comments when modifying code.
- Use docstrings for public interfaces and complex behavior.

### Complexity

- Avoid unnecessary layers of abstraction.
- Do not create helper classes for simple operations.
- Do not introduce interfaces or base classes without a real need.
- Avoid generic frameworks for problems with a narrow scope.
- Prefer direct implementations when they are easier to maintain.

---

## 3. Python Guidelines

Follow modern Python conventions and Home Assistant development
practices.

### General

- Follow PEP 8 and existing project formatting conventions.
- Use type hints for functions, methods, and public interfaces.
- Prefer clear and explicit Python constructs.
- Use standard library functionality when appropriate.
- Avoid unnecessary third-party dependencies.
- Avoid overly compact comprehensions when loops are clearer.
- Avoid deeply nested conditional expressions.
- Use constants for meaningful repeated values.
- Prefer pathlib for filesystem operations when appropriate.

### Async Programming

Home Assistant is built around asyncio.

- Use async/await correctly.
- Never block the Home Assistant event loop.
- Use Home Assistant executor helpers for blocking operations.
- Avoid unnecessary background tasks.
- Handle task cancellation correctly.
- Do not introduce concurrency without a clear reason.
- Follow existing Home Assistant patterns for scheduling tasks.

### Error Handling

- Catch specific exceptions whenever possible.
- Do not silently suppress errors.
- Avoid broad exception handlers unless justified.
- Do not use exceptions for normal control flow.
- Provide meaningful error messages.
- Log errors at appropriate severity levels.
- Never hide programming errors behind fallback values.

### Defensive Programming

Avoid unnecessary defensive programming.

- Do not add redundant None checks.
- Do not validate values already guaranteed by a trusted interface.
- Do not introduce speculative fallback behavior.
- Validate external data at appropriate boundaries.
- Handle realistic failure scenarios explicitly.

---

## 4. Home Assistant Integration Guidelines

Follow Home Assistant architecture and integration conventions.

### Architecture

- Follow the established structure of the integration.
- Use Home Assistant APIs instead of reinventing functionality.
- Keep integration setup and teardown logic clear.
- Separate entity behavior from API communication when appropriate.
- Avoid unnecessary service layers.
- Do not introduce architectural changes without justification.

### Entities

- Follow Home Assistant entity lifecycle conventions.
- Use appropriate entity properties and methods.
- Avoid unnecessary state updates.
- Use coordinators when they provide meaningful benefits.
- Do not create coordinators for functionality that does not need them.
- Maintain stable unique IDs.
- Preserve entity registry compatibility.
- Avoid unnecessary changes to existing entity identifiers.

### Data Updates

- Avoid redundant API requests.
- Respect configured update intervals.
- Use DataUpdateCoordinator when appropriate.
- Handle unavailable external services gracefully.
- Avoid blocking operations.
- Do not introduce unnecessary polling.

### Configuration

- Follow Home Assistant config flow conventions.
- Prefer existing configuration patterns.
- Avoid duplicate configuration logic.
- Preserve backward compatibility when reasonable.
- Do not introduce breaking configuration changes unnecessarily.

### Logging

- Use Python logging conventions.
- Prefer meaningful and actionable log messages.
- Avoid excessive debug logging.
- Never log credentials, tokens, or sensitive information.
- Avoid logging the same error repeatedly without benefit.

---

## 5. JavaScript Guidelines

JavaScript code must prioritize clarity and predictable behavior.

### General

- Use modern JavaScript syntax supported by the target environment.
- Prefer const over let when reassignment is unnecessary.
- Avoid var.
- Use descriptive names.
- Prefer strict equality.
- Avoid unnecessary type coercion.
- Avoid deeply nested callbacks.
- Prefer async/await over complicated promise chains.
- Avoid unnecessary dependencies.

### Functions

- Keep functions focused and understandable.
- Avoid unnecessarily compact arrow functions.
- Do not combine unrelated operations into one expression.
- Prefer explicit conditions when they improve readability.
- Avoid unnecessary helper functions.

### State Management

- Keep state management simple.
- Avoid duplicating state unnecessarily.
- Make state changes predictable.
- Avoid hidden side effects.
- Keep UI updates understandable.

### DOM and Events

- Use standard browser APIs when appropriate.
- Avoid unnecessary DOM manipulation.
- Register and remove event listeners correctly.
- Avoid memory leaks.
- Prefer clear event handling logic.

---

## 6. HTML and UI Guidelines

HTML should be semantic, accessible, and easy to maintain.

- Use semantic HTML elements.
- Keep markup readable and consistently formatted.
- Avoid unnecessary wrapper elements.
- Avoid excessive nesting.
- Separate structure, styling, and behavior when practical.
- Use meaningful element names and attributes.
- Follow accessibility best practices.
- Avoid inline JavaScript event handlers.
- Avoid duplicating markup unnecessarily.

### Home Assistant Frontend

When working with Home Assistant frontend components:

- Follow existing frontend conventions.
- Use supported Home Assistant frontend APIs.
- Avoid relying on undocumented internal behavior.
- Preserve compatibility with supported Home Assistant versions.
- Keep component rendering logic understandable.
- Avoid unnecessary re-rendering.
- Clean up resources and event listeners appropriately.

---

## 7. Refactoring Guidelines

Refactoring must improve maintainability without introducing
unnecessary complexity.

When refactoring:

1. Understand the existing behavior.
2. Identify the actual maintainability problem.
3. Choose the simplest improvement.
4. Preserve existing functionality.
5. Avoid unrelated changes.
6. Avoid introducing unnecessary abstractions.
7. Verify that the resulting code is easier to understand.

Do not refactor working code merely to introduce a design pattern.

Do not split code into additional files or classes unless doing
so provides a clear organizational benefit.

Prefer small, focused changes over large rewrites.

---

## 8. Changes to Existing Code

When modifying existing functionality:

- Read and understand the relevant code first.
- Follow established naming and architectural conventions.
- Minimize the scope of changes.
- Avoid unrelated formatting changes.
- Do not rewrite working code unnecessarily.
- Preserve existing public interfaces unless changes are required.
- Preserve backward compatibility when practical.
- Remove obsolete code made unnecessary by the change.
- Avoid adding compatibility layers without a real requirement.

Do not introduce new architectural patterns when existing
patterns adequately solve the problem.

---

## 9. Testing and Validation

Code must be correct and maintainable.

- Follow existing testing conventions.
- Add or update tests when behavior changes.
- Prefer tests that verify observable behavior.
- Avoid tests tightly coupled to implementation details.
- Do not introduce excessive mocking.
- Keep test code readable.
- Use descriptive test names.
- Cover meaningful edge cases.
- Avoid testing trivial implementation details.

When modifying Home Assistant integration behavior:

- Verify entity state handling.
- Verify setup and unload behavior when relevant.
- Verify error handling.
- Verify asynchronous behavior.
- Verify configuration compatibility when relevant.

Run available relevant tests and linters before completing work.

Do not claim tests passed unless they were actually executed.

---

## 10. Avoid AI-Generated Code Smells

Actively avoid common problems in AI-generated code.

Do not:

- Create unnecessary helper functions.
- Introduce excessive abstraction layers.
- Add redundant validation.
- Add speculative error handling.
- Create generic utilities for one-time operations.
- Introduce unnecessary configuration options.
- Add comments explaining obvious code.
- Use clever one-liners that reduce readability.
- Duplicate existing functionality.
- Introduce unnecessary dependencies.
- Split simple logic across multiple files.
- Add fallback behavior without a documented requirement.
- Create elaborate solutions for simple problems.

Prefer straightforward code that an experienced developer
would naturally write and maintain.

---

## 11. Self-Review Before Completion

Before considering any implementation complete, review
the generated or modified code.

Ask yourself:

1. Is this the simplest reasonable implementation?
2. Can another developer understand it without explanation?
3. Are variable and function names meaningful?
4. Is any abstraction unnecessary?
5. Is any defensive programming redundant?
6. Could the control flow be clearer?
7. Does the implementation follow existing project conventions?
8. Did I introduce unnecessary dependencies?
9. Did I modify unrelated functionality?
10. Would this code be easy to debug six months from now?

If the implementation fails any of these checks,
simplify or improve it before completing the task.

---

## 12. Final Response Guidelines

After completing a coding task:

- Briefly explain what changed.
- Explain important implementation decisions.
- Mention relevant compatibility considerations.
- Report tests and validation actually performed.
- Clearly identify any unresolved issues.

Avoid lengthy explanations of obvious code.

Do not claim functionality was verified unless it was tested.

---

## Refactoring for Human Readability

When refactoring existing code, the primary objective is to reduce
the cognitive effort required to understand the implementation.

- Prefer explicit, linear execution flow.
- Keep related operations together.
- Avoid excessive indirection between functions.
- Do not extract helper functions unless they meaningfully improve
  readability, reuse, or separation of responsibilities.
- Use intermediate variables to explain complex calculations.
- Add comments explaining non-obvious decisions and algorithms.
- Prefer several simple statements over one complex expression.
- Optimize for understanding the code during debugging.

A developer should be able to follow the main execution path
without constantly navigating between functions or files.

When deciding between two implementations, prefer the one
that requires less mental effort to understand and maintain.

---

## Final Principle

Write code for the developer who will maintain it next.

Prefer clarity over cleverness.
Prefer simplicity over abstraction.
Prefer consistency over novelty.
Prefer maintainability over brevity.

Human-readable code is a requirement, not an optional improvement.