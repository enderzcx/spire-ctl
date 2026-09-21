# spire-ctl

Read docs/AGENT.md for gameplay. This is a Node 22+ project with no npm dependencies. `npm test` and `npm run check` validate the controller. Game files and local credentials must never enter Git. The mod lives in its own repository (sts2-bridge). Work against the public JSON state contract; a model is not the authority for game legality or command completion.

For code changes, preserve stale-state rejection, single-writer locking, no mutation retry, persistent uncertainty stops, and one-room battle limits. Runtime tests require a running user-owned game. Offline tests do not prove game compatibility.
