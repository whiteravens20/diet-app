

You are a senior product architect, lead full-stack engineer, mobile architect, and AI systems designer. Your task is to design a production-ready ecosystem consisting of:

1. A primary web application for diet planning, recipe generation, meal scheduling, shopping list optimization, and user profile management.
2. A separate Android companion application consuming the same backend API.

IMPORTANT:
- The web application is the main product and highest priority.
- The Android app is a secondary companion application.
- The architecture must be designed from the beginning for both applications.
- Generate TWO SEPARATE IMPLEMENTATION PLANS:
  1. Web Application Plan
  2. Android Companion App Plan
- Generate recommendations for TWO SEPARATE REPOSITORIES:
  - one repository for the web platform
  - one repository for the Android companion app
- Clearly define shared backend/API contracts so another LLM or developer can continue work independently in each repository.
- Include LLM reference documentation strategy so future AI agents can understand project structure, conventions, architecture, and workflows.

IMPORTANT PRODUCT PRINCIPLES
1. Use a fixed, curated product database as the source of truth for ingredients, nutrition values, allergen flags, categories, and units.
2. AI should not invent nutrition facts. AI may be used to generate recipes, meal plans, substitution suggestions, and shopping list optimizations only within the constraints of the database.
3. All calorie, macro, and ingredient calculations must be deterministic and reproducible.
4. The app must preserve user-selected calorie targets, macro targets, dietary restrictions, meal count, and shopping list constraints.
5. Prioritize the web app first. Design the Android companion app as a separate future client, not as a dependency of the web app.
6. The project must be fully self-hosted friendly and Docker-first.
7. The AI layer must support BYOK (Bring Your Own Key) architecture.
8. The application must work even when the user does not provide an external AI API key.

DESIGN AND UX REQUIREMENTS
The applications must have:
- a modern premium UI
- visually polished design
- smooth animations and transitions
- responsive layouts
- modern dashboards
- elegant cards and panels
- interactive charts and summaries
- high-quality onboarding experience
- fluid navigation
- mobile-friendly UX
- premium SaaS visual quality
- modern UI microinteractions
- visually appealing loading states and skeletons
- polished typography and spacing
- modern component system
- dark mode support
- accessibility support

The design direction should resemble:
- modern startup SaaS products
- premium health and fitness apps
- polished mobile-first experiences
- high-end modern dashboards

Avoid:
- outdated UI
- generic bootstrap-looking layouts
- enterprise legacy styling
- cluttered UX

AI PROVIDER REQUIREMENTS
The application must support multiple AI providers through a unified abstraction layer:
- OpenAI API
- Anthropic API
- OpenRouter API
- Ollama for local self-hosted models

The system should:
- allow per-user AI provider selection
- allow per-user API keys
- securely encrypt and store API keys
- support admin-level default providers
- support automatic fallback logic
- support provider failover
- support configurable model selection

Examples:
- OpenAI GPT models
- Anthropic Claude models
- OpenRouter routed models
- Ollama local models such as Llama, Mistral, Gemma, DeepSeek, Qwen

AI FALLBACK LOGIC
If the user does not provide any API key:
- the system must still function
- use deterministic fallback logic
- use static recipe templates
- use predefined meal generation rules
- use database-driven recipe composition
- optionally use a locally hosted Ollama instance if configured by the administrator
- never fully block core functionality because of missing AI access

The fallback system should still support:
- meal generation
- substitutions
- shopping list generation
- ingredient optimization
- calorie calculations

SELF-HOSTED REQUIREMENTS
The entire project should be deployable in a self-hosted environment using Docker.

The stack should support:
- Docker Compose
- reverse proxy compatibility
- local-only deployment
- LAN-only deployment
- cloud deployment
- offline-capable development environment

The architecture should avoid vendor lock-in.

DOCKER REQUIREMENTS
Provide:
- docker-compose setup
- production-ready Dockerfiles
- separate containers for frontend, backend, database, cache, and AI services
- environment variable management
- health checks
- persistent volumes
- optional GPU support for Ollama
- example deployment configurations

Recommended containers:
- frontend
- backend API
- PostgreSQL
- Redis
- Ollama
- nginx or Traefik reverse proxy
- worker/queue service

AUTHENTICATION AND SECURITY REQUIREMENTS
Authentication should support:
- email/password login
- secure sessions
- JWT or secure session-based auth
- password reset flow
- optional email verification
- optional two-factor authentication later

Add optional Cloudflare Turnstile support for:
- login forms
- registration forms
- password reset requests
- anonymous AI-heavy endpoints

The system should:
- allow enabling or disabling Turnstile via environment variables
- support self-hosted deployments without Turnstile
- gracefully fallback if Turnstile is disabled
- support rate limiting and anti-abuse protections even without Turnstile

PRODUCT OVERVIEW
Build a diet and meal-planning application ecosystem that:
- Lets users create profiles.
- Calculates daily calorie needs from age, height, weight, and optionally sex and activity level.
- Offers 4 weekly weight-loss targets from 0.25 kg/week to 1.0 kg/week.
- Automatically converts the selected weight-loss target into a daily calorie target.
- Also allows the user to manually enter any daily calorie target.
- Lets the user choose a diet type, meal count, and planning duration.
- Generates a daily or multi-day meal plan with recipes that match the target calories and approximate macro balance.
- Optimizes ingredients across multiple meals to reduce food waste and increase ingredient reuse.
- Produces a consolidated shopping list for the selected time range.
- Supports favorite recipes and favorite meals per user profile.
- Supports swapping a meal with a random alternative from the same diet category or from favorites.
- Supports swapping a single ingredient inside a recipe with a suitable substitute while preserving calories as closely as possible.
- Supports synchronization between web and Android companion app.

CORE FEATURES

1. Authentication and user accounts
- Email/password login and registration.
- Optional social login later, but not required for MVP.
- Secure session handling.
- Password reset.
- User profile ownership and privacy.

2. User profile
Allow one or more profiles per account, each profile storing:
- name or nickname
- age
- sex
- height
- weight
- activity level
- dietary goal
- weight-loss target per week: 0.25 kg, 0.5 kg, 0.75 kg, 1.0 kg
- manual calorie override, always available
- dietary preferences
- excluded ingredients
- allergens
- disliked foods
- favorite recipes
- favorite meals
- preferred cuisine types
- preferred meal count defaults

3. Calorie and macro calculation
Implement a transparent and editable calculation system:
- Estimate maintenance calories from profile data.
- Apply calorie deficit based on weekly fat-loss goal.
- Convert weekly loss target to daily deficit.
- Let the user override the final daily calorie target manually.
- Optionally estimate target protein, fat, and carbohydrates.
- Show calculations clearly in the UI.
- Explain when values are estimated and when they are user-entered.

4. Diet and meal planning
The user can:
- select a diet type such as balanced, high-protein, low-carb, vegetarian, vegan, keto, Mediterranean, or custom
- choose daily calorie target
- choose 2 to 5 meals per day
- select a planning period in a calendar for a chosen number of days
- generate a meal plan for that period
- regenerate the plan if needed

Meal planning must:
- respect daily calorie target
- keep macros as close as possible to target
- reuse ingredients intelligently across multiple days
- minimize ingredient waste
- prefer recipes that make use of the same purchased products across several meals
- support leftovers, batch-cooked ingredients, and multi-use ingredients
- optionally suggest meal prep-friendly plans

5. Recipe generation
Recipes should be generated using:
- structured product database
- deterministic nutrition data
- recipe templates and AI-assisted composition
- constraints from diet type and macro targets

Each recipe should include:
- title
- description
- servings
- ingredients with exact quantities
- step-by-step instructions
- total calories
- macro breakdown
- prep time
- cook time
- difficulty
- dietary tags
- allergen warnings
- reusable ingredients score
- substitution suggestions

Important:
- Do not invent calories or macros.
- If AI generates a recipe, it must choose only from products and ingredient records available in the database.
- If an ingredient is missing from the database, the system must either reject it or map it to an approved substitute.

6. Favorites and recipe library
- Users can save recipes to favorites.
- Users can sort and filter favorites.
- Users can assign favorites to categories or tags.
- Users can reuse favorites in new meal plans.
- Users can mark meals as often used or avoid.

7. Meal swapping
Users can swap:
- an entire meal with a random meal from the same diet category
- an entire meal with one of their favorites
- a single ingredient in a recipe with a substitute

When swapping:
- keep calories close to the original
- keep macros as close as possible
- respect diet restrictions
- show the calorie and macro delta before confirming

8. Ingredient substitution
The user can choose an ingredient inside a recipe and replace it with another ingredient such as rice, pasta, potatoes, or other compatible products.
The system must:
- calculate the exact replacement quantity
- preserve calorie target as closely as possible
- keep macro balance as close as possible
- obey dietary restrictions and allergen filters
- explain the substitution result clearly

9. Shopping list
Generate a shopping list for:
- one day
- multiple days
- the full selected planning period

Shopping list requirements:
- merge duplicate ingredients across recipes
- sum quantities correctly
- normalize units
- group by category such as dairy, vegetables, meat, grains, spices, pantry
- optionally show estimated calories per ingredient group
- support already have at home deductions
- support checkbox completion status
- support export and copy functionality

10. Ingredient reuse optimization
The system should plan meals so purchased products are used efficiently.
Examples:
- If 1 liter of milk is bought, plan meals that use it across 2 to 3 days.
- Prefer ingredient overlap across recipes within the planning period.
- Reduce leftover waste.
- Use batch-friendly planning logic.

This optimization should be a scoring problem that balances:
- nutritional fit
- variety
- ingredient reuse
- cost efficiency
- cooking complexity
- user preferences
- time constraints

11. Search, filters, and sorting
The app should support search and filtering across:
- recipes
- ingredients
- favorites
- meal plans
- shopping list entries

Filters should include:
- diet type
- calories
- macro profile
- meal type
- prep time
- ingredients
- allergens
- difficulty
- favorite status

12. Calendar planning
The user can:
- choose a start date
- choose a planning duration in days
- preview each days meals
- edit meals per day
- regenerate a single day or a range of days
- export the plan

13. Dashboard and analytics
Show the user:
- daily calorie target
- planned intake
- macro totals
- adherence to the diet target
- ingredient reuse efficiency
- shopping list summary
- favorite recipe frequency

14. Android companion app
Design the backend and API so an Android companion app can be built later.
The Android app should:
- reuse the same auth
- reuse the same profile system
- reuse the same meal plan data
- reuse the same shopping list data
- support offline viewing of cached meal plans and shopping lists
- be able to sync changes later

The Android app is not the first deliverable. Focus on making the architecture clean enough that it can be added later without major refactoring.

REPOSITORY REQUIREMENTS

Repository 1:
- Web platform repository
- frontend
- backend
- infrastructure
- docker setup
- AI orchestration
- shared API contracts
- documentation for future LLM agents
- architecture diagrams
- coding conventions
- prompt engineering references

Repository 2:
- Android companion app repository
- Android-specific architecture
- API integration layer
- offline synchronization layer
- mobile caching strategy
- mobile UI system
- documentation for future LLM agents
- integration contracts with backend

LLM REFERENCE DOCUMENTATION REQUIREMENTS
Each repository should contain:
- architecture overview
- folder structure explanation
- naming conventions
- API documentation
- domain model explanation
- prompt engineering documentation
- coding standards
- deployment instructions
- Docker instructions
- onboarding guide for future developers or LLM agents
- decision logs and ADRs
- environment variable reference
- AI provider integration documentation

RECOMMENDED TECH STACK

Web Frontend:
- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui
- Framer Motion
- React Query
- PWA support

Backend:
- NestJS or FastAPI
- TypeScript preferred for full-stack consistency
- REST or GraphQL API
- JWT auth
- Background job queue

Database:
- PostgreSQL
- Prisma ORM recommended

Caching and queues:
- Redis
- BullMQ or equivalent

AI orchestration:
- Provider abstraction layer
- LangChain optional but not required
- Structured prompt pipelines
- Tool-calling support
- Deterministic validation layer after AI responses

Android:
- Kotlin
- Jetpack Compose
- Material 3
- Offline-first architecture
- modern animations and transitions

DATA MODEL REQUIREMENTS
Design a relational or hybrid data model with at least these entities:
- users
- profiles
- profile_preferences
- ingredients
- products
- nutrition_facts
- allergens
- recipes
- recipe_ingredients
- meal_plans
- meal_plan_days
- planned_meals
- favorites
- shopping_lists
- shopping_list_items
- substitution_rules
- ai_provider_configs
- ai_usage_logs
- audit_logs

Each ingredient/product record should store:
- name
- canonical unit
- nutrition per 100 g or per serving
- category
- tags
- allergens
- diet compatibility
- density or conversion data if needed
- brand optional
- expiration or storage hints optional

TECHNICAL REQUIREMENTS
Design the app as a scalable, maintainable product with:
- frontend
- backend API
- database
- authentication
- authorization
- AI orchestration layer
- nutrition calculation service
- shopping list aggregation service
- meal planning optimizer
- recipe generation service

Recommended architecture:
- API-first backend
- modular service boundaries
- database-driven nutrition logic
- deterministic calculation engine
- AI layer as an assistant, not as a source of truth

NON-FUNCTIONAL REQUIREMENTS
The system must be:
- secure
- scalable
- testable
- maintainable
- auditable
- performant
- accessible
- mobile responsive
- localization-ready
- resilient to bad or incomplete input

SECURITY AND PRIVACY
Include:
- secure password handling
- role-based access control if needed
- protection against unauthorized profile access
- validation of all user inputs
- rate limiting on AI and plan generation endpoints
- encrypted AI API key storage
- logging without exposing sensitive personal data
- clear privacy boundaries for user health-related preference data

UI/UX REQUIREMENTS
The web app should have:
- clean modern interface
- profile setup wizard
- calorie calculator screen
- meal plan builder
- recipe detail view
- substitution modal
- favorites manager
- shopping list screen
- calendar planner
- dashboard with summary cards
- responsive layout for desktop and mobile

The UX should make it easy to:
- enter age, height, weight
- choose weight-loss target
- manually override kcal target
- choose meal count from 2 to 5
- select planning period in calendar
- generate plan
- swap meals
- swap ingredients
- save favorites
- export shopping list

AI USE POLICY FOR THE SYSTEM
The AI layer may:
- draft recipes from constrained inputs
- suggest substitutions
- suggest meal plan variations
- improve ingredient reuse
- propose shopping list optimizations
- explain tradeoffs in plain language

The AI layer must not:
- fabricate nutrition values
- ignore diet constraints
- ignore allergies
- violate calorie targets without reporting the delta
- produce ingredient quantities that cannot be calculated from the database

OUTPUT EXPECTATIONS
When designing the solution, provide:
1. Product specification
2. User stories
3. Functional requirements
4. Non-functional requirements
5. Information architecture
6. Data model
7. API design
8. AI orchestration approach
9. Meal planning algorithm overview
10. Shopping list aggregation logic
11. Ingredient substitution logic
12. Suggested tech stack
13. MVP scope and phased roadmap
14. Risks and mitigation strategies
15. Example screens and flows
16. Testing strategy
17. Deployment strategy
18. Docker deployment structure
19. Ollama integration strategy
20. AI provider abstraction architecture
21. Fallback logic architecture
22. Separate repository strategy
23. Web app implementation roadmap
24. Android companion app roadmap
25. LLM documentation strategy
26. UI design system recommendations
27. Animation and motion design recommendations

MVP PRIORITIES

Phase 1:
- web app only
- authentication
- user profile
- calorie calculation
- manual kcal override
- diet selection
- meal count selection
- date range selection
- meal plan generation
- shopping list generation
- favorites
- meal swapping
- ingredient substitution
- Docker deployment
- BYOK AI support
- fallback logic without external AI

Phase 2:
- improved optimization for ingredient reuse
- better recipe library
- analytics
- exports
- offline support in browser
- local Ollama deployment support

Phase 3:
- Android companion app
- synchronization
- push notifications
- offline-first mobile experience

IMPORTANT INSTRUCTIONS FOR YOU
- Think like a product architect and staff engineer.
- Be concrete and implementation-oriented.
- Prefer structured output.
- Include edge cases.
- Highlight anything that should be stored as static database data versus AI-generated content.
- Propose a design that is realistic for production.
- If something is ambiguous, make a reasonable assumption and state it explicitly.
- Do not provide vague advice only. Give a detailed, buildable blueprint.

Now produce the complete app ecosystem design in a structured format with separate implementation plans for:
1. Web Application
2. Android Companion App
3. Shared Backend and Infrastructure
4. Separate Repository Structures
5. LLM Reference Documentation Strategy