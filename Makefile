.PHONY: install dev build lint typecheck test test-e2e format audit clean

install:
	npm install

dev:
	npm run dev

build:
	npm run build

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm run test

test-e2e:
	npx tsx scripts/test-e2e-neon.ts

format:
	npm run format

format-check:
	npm run format:check

audit:
	npm audit --audit-level=high

clean:
	rm -rf dist apps/*/dist packages/*/dist
