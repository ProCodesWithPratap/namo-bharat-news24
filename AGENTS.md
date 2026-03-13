# Rules
- Run install, lint, build, and tests before finishing.
- Test the live Railway deployment, not only localhost.
- Verify admin panel login, save/update buttons, uploads, CRUD, and permissions.
- Do not claim something works unless it was actually tested.
- After every fix, re-run the relevant checks and then do one final verification pass.

# Commands
- install: npm install
- lint: npm run lint
- build: npm run build
- test: npm test
- e2e: npx playwright test
