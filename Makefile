.PHONY: help check up down logs migrate seed restart rebuild webhook test

COMPOSE := docker compose -f docker-compose.full.yml

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

check: ## Validate .env and connectivity
	@bash scripts/doctor.sh

up: ## Build + start the full stack (app, postgres, redis)
	$(COMPOSE) up -d --build

up-https: ## Start the stack WITH automatic HTTPS (needs PUBLIC_DOMAIN + DNS)
	$(COMPOSE) --profile https up -d --build

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail application logs
	$(COMPOSE) logs -f app

restart: ## Restart the app container
	$(COMPOSE) restart app

rebuild: ## Rebuild and restart the app
	$(COMPOSE) up -d --build app

migrate: ## Run DB migrations inside the app container
	$(COMPOSE) exec app npx prisma migrate deploy

seed: ## (Re)create the owner record
	$(COMPOSE) exec app node dist/scripts/seed.js

webhook: ## Register the WhatsApp webhook with Meta via Graph API
	@bash scripts/register-whatsapp-webhook.sh

test: ## Run the test suite (local node)
	npm test
