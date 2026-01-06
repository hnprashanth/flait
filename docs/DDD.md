# Definition of Done (DoD)

## Code Quality
- [ ] Code compiles without errors (`npm run build`).
- [ ] No linting errors (run `npm run lint` if configured, otherwise ensure clean code).
- [ ] All new functions have JSDoc comments explaining parameters and return values.
- [ ] Variable and function names follow the project's camelCase convention.
- [ ] No `console.log` statements (use a proper logger or `console.error` for errors).

## Testing
- [ ] Unit tests added/updated for all logic changes (`npm run test`).
- [ ] Integration tests passed where applicable (`npm run test:flight`).
- [ ] Test coverage is maintained or improved.

## Infrastructure (AWS CDK)
- [ ] `npx cdk synth` runs successfully.
- [ ] `npx cdk diff` shows expected changes only.
- [ ] IAM roles are least-privileged (avoid `*` where possible).
- [ ] Resource removal policies are correct (RETAIN for prod, DESTROY for dev).

## Documentation
- [ ] README.md updated if architecture or usage changes.
- [ ] Architecture diagrams updated if applicable.
- [ ] New environment variables documented.

## Security
- [ ] No hardcoded secrets.
- [ ] Inputs are validated (e.g., API Gateway request validation).
