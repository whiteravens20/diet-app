# The codes a request is refused with

Written by `npm run contract` from the source of the API and from the message catalogue (`apps/web/messages/`); a test fails when this file is not what the command writes.

A refusal is an `ApiError`: its `error` is one of the 146 codes below, and its `message` an English sentence for a log. What a person is shown is the sentence of their language: `errors.<code>` in the catalogue of that language, which has one for every code. A text in braces is filled in from the `details` of the answer where the code has any. The status is the one the source gives beside the code; a code that is handed on to whatever throws it is listed without one.

| Code | Status | In English | In Polish |
|---|---|---|---|
| `ADMIN_DISABLED` | 403 | The admin panel is disabled on this instance. | Panel administracyjny jest wyłączony na tej instancji. |
| `ADMIN_SECOND_FACTOR_RESET_SET` | 409 | ADMIN_SECOND_FACTOR_RESET is on: a second step would be removed at the next start. Switch it off and restart the API first. | ADMIN_SECOND_FACTOR_RESET jest włączone: drugi etap zostałby usunięty przy następnym starcie. Najpierw wyłącz tę opcję i zrestartuj API. |
| `AI_CONFIG_NOT_FOUND` | 404 | AI provider configuration not found. | Nie znaleziono konfiguracji dostawcy AI. |
| `AI_DRAFT_DAILY_LIMIT` | 429 | AI has written as many recipes for you as it may in one day. Try again tomorrow. | AI napisało już dla Ciebie tyle przepisów, ile może w ciągu jednego dnia. Spróbuj ponownie jutro. |
| `AI_DRAFT_INVALID` | 400 | AI returned a malformed recipe draft — try a different prompt. | AI zwróciło niepoprawny szkic przepisu — spróbuj innego opisu. |
| `AI_DRAFT_OFF_DIET` | 400 | The AI's recipe does not fit the diet you asked for — try again. | Przepis od AI nie pasuje do diety, o którą prosisz — spróbuj ponownie. |
| `AI_DRAFT_OFF_TARGET` | 400 | The AI's recipe came out far from the calories you asked for — try again. | Przepis od AI wyszedł daleko od kaloryczności, o którą prosisz — spróbuj ponownie. |
| `AI_DRAFT_UNKNOWN_INGREDIENT` | 400 | AI proposed an ingredient it was not offered — try again. | AI zaproponowało składnik, którego nie było na liście — spróbuj ponownie. |
| `AI_INSTANCE_LIMIT_REACHED` | 403 | This instance's shared AI requests for the month are used up. | Wspólna pula zapytań AI tej instancji na ten miesiąc została wykorzystana. |
| `AI_KEY_UNREADABLE` | 409 | A saved AI provider key can no longer be read — enter it again in Settings. | Zapisanego klucza dostawcy AI nie da się już odczytać — wprowadź go ponownie w Ustawieniach. |
| `AI_MONTHLY_LIMIT_REACHED` | 403 | You've used your AI requests for this month. | Skończył się Twój miesięczny limit zapytań AI. |
| `AI_NOT_CONFIGURED` | 409 | No AI provider is set up for your account — choose one in Settings. | Nie masz skonfigurowanego dostawcy AI — wybierz go w Ustawieniach. |
| `AI_PROVIDER_TIMEOUT` | 503 | AI provider was too slow — try a smaller model or a cloud provider. | Dostawca AI był zbyt wolny — wybierz mniejszy model lub usługę w chmurze. |
| `AI_UNAVAILABLE` | 503 | The AI provider didn't respond — try again in a moment. | Dostawca AI nie odpowiedział — spróbuj ponownie za chwilę. |
| `AUTH_REQUIRED` | 401 | Sign in to continue. | Zaloguj się, aby kontynuować. |
| `BAD_REQUEST` | 400 | The request could not be understood. | Nie udało się zrozumieć żądania. |
| `BYOK_NO_PROVIDER` | 400 | Add at least one provider key before switching to bring-your-own. | Dodaj co najmniej jeden klucz dostawcy, zanim przełączysz się na własny klucz. |
| `CONFLICT` | 409 | That already exists. | Taki wpis już istnieje. |
| `CUSTOM_MEAL_INVALID_MACROS` | 400 | Custom meal macros must be non-negative numbers. | Makroskładniki własnego posiłku muszą być liczbami nieujemnymi. |
| `CUSTOM_MEAL_NOT_SWAPPABLE` | 400 | Custom meals can't be swapped or have ingredients substituted. | Własnych posiłków nie można wymieniać ani podmieniać w nich składników. |
| `CUSTOM_SPLIT_MISSING` | 400 | The custom diet needs a split of protein, fat and carbohydrate. Set one on the profile first. | Dieta własna wymaga podziału na białko, tłuszcz i węglowodany. Ustaw go najpierw w profilu. |
| `DAY_NOT_FOUND` | 404 | Day not found in this plan. | Nie znaleziono dnia w tym planie. |
| `DRAFT_INVALID` | 400 | The draft would break the rules for recipe text and quantities. Nothing was saved. | Szkic złamałby zasady dotyczące tekstu i ilości w przepisie. Nic nie zostało zapisane. |
| `DRAFT_NOT_APPROVED` | 409 | Draft must be approved in every locale before it can be promoted. | Szkic musi być zatwierdzony w każdym języku, zanim trafi do biblioteki. |
| `DRAFT_NOT_FOUND` | 404 | Draft not found. | Nie znaleziono szkicu. |
| `DRAFT_NOT_PROMOTABLE` | 400 | Only user-drafted (AI_USER) recipes can be promoted to curated. | Do biblioteki można przenieść tylko przepisy napisane dla użytkownika przez AI (AI_USER). |
| `DRAFT_NOT_SHIPPABLE` | 409 | This draft cannot go into the library as it is: | Ten szkic nie może w tej postaci trafić do biblioteki: |
| `DRAFT_REJECTED` | 409 | This draft was rejected. Only the administrator can reopen it. | Ten szkic został odrzucony. Ponownie otworzyć może go tylko administrator. |
| `DRAFT_SHIPPED` | 409 | This draft has already shipped and can't be changed. | Ten szkic został już wysłany i nie można go zmieniać. |
| `DRAFT_STRUCTURAL_EDIT_FORBIDDEN` | 403 | User-drafted recipes accept translation edits only — promote first to restructure. | W przepisach użytkowników można zmieniać tylko tłumaczenia — żeby zmienić resztę, najpierw przenieś przepis do biblioteki. |
| `EMAIL_ALREADY_VERIFIED` | 400 | This email address is already verified. | Ten adres e-mail jest już potwierdzony. |
| `EMAIL_CHANGE_REQUIRES_SMTP` | 400 | Changing your email isn't available on this instance — the operator hasn't configured email. | Zmiana adresu e-mail nie jest dostępna na tej instancji — operator nie skonfigurował poczty. |
| `EMAIL_TAKEN` | 400, 409 | That email is already registered. | Ten adres e-mail jest już zarejestrowany. |
| `EMPTY_SET` | 400 | This favourite set has no slots — add at least one before applying. | Ten zestaw ulubionych jest pusty — dodaj do niego co najmniej jeden posiłek, zanim go zastosujesz. |
| `EMPTY_UPDATE` | 400 | Nothing to update. | Brak zmian do zapisania. |
| `FAVORITE_LIMIT_REACHED` | 409 | This profile already has as many marked recipes as it can hold. Remove a mark first. | Ten profil ma już tyle oznaczonych przepisów, ile może mieć. Najpierw usuń jedno oznaczenie. |
| `FAVORITE_NOT_FOUND` | 404 | That recipe is not marked for this profile. | Ten przepis nie jest oznaczony dla tego profilu. |
| `FAVORITE_SET_ALLERGEN_CONFLICT` | 400 | This favourite set contains a recipe with an allergen this profile avoids — it can't be applied. | Ten zestaw ulubionych zawiera przepis z alergenem, którego ten profil unika — nie można go zastosować. |
| `FAVORITE_SET_LIMIT_REACHED` | 409 | This profile already has as many favorite sets as it can hold. Delete one first. | Ten profil ma już tyle zestawów ulubionych, ile może mieć. Najpierw usuń jeden z nich. |
| `FAVORITE_SET_NOT_ELIGIBLE` | 400 | This set holds a recipe that can't go into this plan: it doesn't fit the diet or the meal, uses an ingredient the profile skips, or is marked to avoid. | Ten zestaw zawiera przepis, którego nie można dodać do tego planu: nie pasuje do diety lub posiłku, zawiera pomijany składnik albo jest oznaczony do unikania. |
| `FORBIDDEN` | 403 | You don't have access to that. | Brak dostępu. |
| `GH_MODE_UNAVAILABLE` | 409 | `gh` CLI not found on PATH. | Nie znaleziono polecenia `gh` w PATH. |
| `GH_PR_CREATE_FAILED` | 409 | Opening the pull request via gh failed. | Utworzenie pull requesta przez gh nie powiodło się. |
| `GIT_FAILED` | 409 | A git command failed during the upstream-PR ship. | Polecenie git zakończyło się błędem podczas wysyłki przez pull request. |
| `IMPORT_IN_PROGRESS` | 409 | A USDA import is already in progress. | Import USDA już trwa. |
| `IMPORT_NOT_JSON` | 400 | This is not a JSON document of recipes. | To nie jest dokument JSON z przepisami. |
| `INGREDIENT_NOT_FOUND` | 404 | Ingredient not found. | Nie znaleziono składnika. |
| `INGREDIENT_NOT_IN_RECIPE` | 404 | This ingredient is not part of the recipe. | Ten składnik nie należy do przepisu. |
| `INTERNAL_ERROR` | 500 | An unexpected server error occurred. | Nieoczekiwany błąd serwera. |
| `INVALID_ACCESS_TOKEN` | 401 | Your session is invalid. Please sign in again. | Sesja jest nieprawidłowa. Zaloguj się ponownie. |
| `INVALID_ADMIN_SESSION` | 401 | The admin session has ended. Sign in again. | Sesja administratora wygasła. Zaloguj się ponownie. |
| `INVALID_CREDENTIALS` | 401 | Email or password is incorrect. | Nieprawidłowy e-mail lub hasło. |
| `INVALID_EMAIL_CHANGE_TOKEN` | 400 | This email-change link is invalid or has expired. | Ten link zmiany adresu e-mail jest nieprawidłowy lub wygasł. |
| `INVALID_LOCKED_SLOT` | 400 | A locked meal doesn't fit the meals chosen for that day. | Przypięty posiłek nie pasuje do posiłków wybranych na ten dzień. |
| `INVALID_PASSWORD` | 401 | Current password is incorrect. | Aktualne hasło jest nieprawidłowe. |
| `INVALID_PULL_SOURCE` | 409 | That's not a repo (owner/repo) or a raw URL. | To nie jest ani repozytorium (owner/repo), ani bezpośredni adres pliku. |
| `INVALID_REFRESH` | 401 | Your session expired. Please sign in again. | Sesja wygasła. Zaloguj się ponownie. |
| `INVALID_RESET_TOKEN` | 400 | This reset link is invalid or has expired. | Ten link do resetu jest nieprawidłowy lub wygasł. |
| `INVALID_REVIEWER_PASSWORD` | 401 | Wrong reviewer password. | Nieprawidłowe hasło recenzenta. |
| `INVALID_REVIEWER_SESSION` | 401 | Your reviewer session expired. Please sign in again. | Sesja recenzenta wygasła. Zaloguj się ponownie. |
| `INVALID_SECOND_FACTOR_CODE` | 401 | That code is not right. Codes change every half a minute, and each works once. | Ten kod jest nieprawidłowy. Kody zmieniają się co pół minuty, a każdy działa tylko raz. |
| `INVALID_SIGN_IN_CHALLENGE` | 401 | This sign-in took too long. Sign in with your password again. | Logowanie trwało zbyt długo. Zaloguj się ponownie hasłem. |
| `INVALID_SUBSTITUTION` | 400 | This substitution isn't valid. | Ta zamiana jest nieprawidłowa. |
| `INVALID_VERIFICATION_TOKEN` | 400 | This confirmation link is invalid or has expired. | Ten link potwierdzający jest nieprawidłowy lub wygasł. |
| `INVENTORY_ITEM_NOT_FOUND` | 404 | Inventory item not found. | Nie znaleziono pozycji w spiżarni. |
| `ITEM_NOT_FOUND` | 404 | Shopping list item not found. | Nie znaleziono pozycji listy zakupów. |
| `LIST_NOT_FOUND` | 404 | Shopping list not found. | Nie znaleziono listy zakupów. |
| `LOCALE_NOT_IN_DRAFT` | 400 | This draft wasn't generated for that locale. | Ten szkic nie został przygotowany w wybranym języku. |
| `LOCKED_RECIPE_INELIGIBLE` | 400 | A locked recipe can't go into this plan: it is unavailable, or the profile's diet, allergens, skipped ingredients or avoided recipes rule it out. | Przypiętego przepisu nie można dodać do tego planu: jest niedostępny albo wyklucza go dieta, alergeny, pomijane składniki lub oznaczenie do unikania. |
| `MEAL_EATEN` | 409 | This meal is marked as eaten and can't be changed. Unmark it first. | Ten posiłek jest oznaczony jako zjedzony i nie można go zmienić. Najpierw cofnij oznaczenie. |
| `MEAL_NOT_FOUND` | 404 | Meal not found in this plan. | Nie znaleziono posiłku w tym planie. |
| `MEAL_NOT_REBALANCEABLE` | 400 | Custom and eaten meals are never rebalanced. | Własne i zjedzone posiłki nie są przeliczane. |
| `METHOD_NOT_ALLOWED` | 405 | That action is not available here. | Ta operacja nie jest tutaj dostępna. |
| `MODEL_PICK_INVALID` | 400 | This suggestion is no longer good for what it was made for. Ask for another. | Ta propozycja nie pasuje już do tego, dla czego powstała. Poproś o nową. |
| `NAMER_IN_PROGRESS` | 409 | An ingredient-namer run is already in progress. | Generowanie nazw składników już trwa. |
| `NOTHING_TO_REGENERATE` | 409 | Every one of those days is before today. Days in the past are made again only when you say so. | Wszystkie te dni już minęły. Minione dni są układane ponownie tylko wtedy, gdy o to poprosisz. |
| `NOTIFICATION_NOT_FOUND` | 404 | Notification not found. | Nie znaleziono powiadomienia. |
| `NOT_FOUND` | 404 | That does not exist. | Nie znaleziono. |
| `NO_ALTERNATIVE` | 404 | No alternative recipe found. | Nie znaleziono alternatywnego przepisu. |
| `NO_APPROVED_DRAFTS` | 409 | There are no approved drafts to ship. | Brak zatwierdzonych szkiców do wysłania. |
| `NO_CURRENT_OVERRIDES` | 409 | This instance has no ingredient overrides to export or push yet. | Ta instancja nie ma jeszcze żadnych nadpisań składników do eksportu lub wysyłki. |
| `NO_ELIGIBLE_INGREDIENTS` | 400 | No ingredients match your diet and allergen settings. | Żadne składniki nie pasują do diety i alergenów profilu. |
| `NO_ELIGIBLE_RECIPE` | 400 | No recipe matches the current constraints. | Żaden przepis nie spełnia obecnych ograniczeń. |
| `NO_FAVORITE_INGREDIENTS` | 400 | Add favourite ingredients on the profile before swapping by them. | Najpierw dodaj w profilu ulubione składniki — dopiero wtedy da się dobrać zamianę według nich. |
| `NO_FAVORITE_INGREDIENT_MATCH` | 404 | No recipe matches your favourite ingredients. | Żaden przepis nie pasuje do Twoich ulubionych składników. |
| `NO_REVIEWER_SESSION` | 401 | Sign in to continue reviewing. | Zaloguj się, aby kontynuować recenzowanie. |
| `NO_VALID_DRAFTS` | 409 | None of the approved drafts can ship as they are. | Żaden z zatwierdzonych szkiców nie może zostać wysłany w obecnej postaci. |
| `OFFER_INVALID` | 400 | This offer is no longer good for what it was made for. Ask for another. | Ta propozycja nie pasuje już do tego, dla czego powstała. Poproś o nową. |
| `OFF_DIET_FAVORITE_NOT_ALLOWED` | 400 | That favourite can't go into this slot: it doesn't fit the meal or the diet, or the profile's allergens, skipped ingredients or avoid mark rule it out. | Tego ulubionego przepisu nie można tu wstawić: nie pasuje do posiłku lub diety albo wykluczają go alergeny, pomijane składniki lub oznaczenie do unikania. |
| `OLLAMA_HOST_NOT_ALLOWED` | 400 | That Ollama address isn't allowed on this instance. Ask the operator to add it to OLLAMA_ALLOWED_HOSTS. | Ten adres Ollama nie jest dozwolony na tej instancji. Poproś operatora o dodanie go do OLLAMA_ALLOWED_HOSTS. |
| `OLLAMA_USER_DISABLED` | 400 | Bring-your-own Ollama is turned off on this instance. | Własna instancja Ollama jest wyłączona na tej instancji. |
| `ORIGIN_NOT_ALLOWED` | 403 | This request has to come from the application itself. Reload the page and try again. | To żądanie musi pochodzić z samej aplikacji. Odśwież stronę i spróbuj ponownie. |
| `OUT_OF_COMPLEXITY_BAND` | 400 | Recipe is outside every complexity band — adjust ingredients, steps, or time. | Przepis nie mieści się w żadnym przedziale złożoności — zmień składniki, kroki lub czas. |
| `OVERRIDE_DATE_OUT_OF_RANGE` | 400 | An advanced day option falls outside the plan's date range. | Ustawienie dnia wykracza poza zakres dat planu. |
| `PANTRY_FULL` | 409 | The pantry already holds as many items as it can. Remove one first. | Spiżarnia ma już tyle pozycji, ile może pomieścić. Najpierw usuń jedną z nich. |
| `PAYLOAD_TOO_LARGE` | 413 | The request is too large. | Żądanie jest zbyt duże. |
| `PERSONAL_RECIPE_LIMIT` | 403 | You have as many recipes of your own as an account can hold. Delete some you no longer use. | Masz już tyle własnych przepisów, ile mieści jedno konto. Usuń te, których już nie używasz. |
| `PLAN_CHANGED` | 409 | The plan changed in the meantime. It has been reloaded; try again. | Plan zmienił się w międzyczasie. Został odświeżony — spróbuj ponownie. |
| `PLAN_NEEDS_RELAXATION` | 422 | The plan cannot be filled inside its limits. Let the limits that stand in the way give way, or change what the plan is asked for. | Planu nie da się ułożyć w jego limitach. Pozwól przekroczyć limity, które stoją na przeszkodzie, albo zmień to, o co prosisz w planie. |
| `PLAN_NOT_FOUND` | 404 | Meal plan not found. | Nie znaleziono planu posiłków. |
| `PROFILE_LIMIT_REACHED` | 409 | You've reached the maximum number of profiles. | Osiągnięto maksymalną liczbę profili. |
| `PROFILE_NOT_FOUND` | 404 | Profile not found. | Nie znaleziono profilu. |
| `PULL_ADDRESS_NOT_PUBLIC` | 409 | That source is not at a public address. A source inside your own network is fetched only when its host is named in OVERRIDES_PULL_ALLOWED_HOSTS. | To źródło nie jest pod adresem publicznym. Źródło w sieci wewnętrznej jest pobierane tylko wtedy, gdy jego host jest wpisany w OVERRIDES_PULL_ALLOWED_HOSTS. |
| `PULL_FETCH_FAILED` | 409 | Could not fetch the overrides file. Check the repo, the branch and the access token; a redirect is not followed, and a file over 2 MB is not read. | Nie udało się pobrać pliku nadpisań. Sprawdź repo, gałąź i token dostępu; przekierowania nie są obsługiwane, a plik większy niż 2 MB nie jest czytany. |
| `PULL_SHAPE_INVALID` | 409 | The fetched file is not a valid ingredient-overrides.json. | Pobrany plik nie jest prawidłowym ingredient-overrides.json. |
| `QUANTITY_TOO_LARGE` | 400 | That quantity is larger than a kitchen holds. Check the number. | Ta ilość jest większa, niż mieści kuchnia. Sprawdź liczbę. |
| `RANGE_OUTSIDE_PLAN` | 400 | Those days are not days of this plan, or the first is after the last. | Te dni nie należą do tego planu albo pierwszy jest późniejszy niż ostatni. |
| `RATE_LIMITED` | 429 | Too many requests. Try again in a moment. | Zbyt wiele żądań. Spróbuj ponownie za chwilę. |
| `RECIPE_GEN_IN_PROGRESS` | 409 | A recipe-generator run is already in progress. | Generowanie przepisów już trwa. |
| `RECIPE_NOT_ELIGIBLE` | 400 | That recipe can't go into this plan. | Tego przepisu nie można dodać do tego planu. |
| `RECIPE_NOT_FOUND` | 404 | Recipe not found. | Nie znaleziono przepisu. |
| `RECIPE_NOT_SUBMITTABLE` | 409 | This recipe uses an ingredient outside the catalogue, so it can't be suggested for the library. | Ten przepis zawiera składnik spoza katalogu, więc nie można go zgłosić do biblioteki. |
| `REFERENCE_CONFLICT` | 409 | The request refers to something that does not exist or is still in use. | Żądanie odwołuje się do czegoś, co nie istnieje albo jest nadal używane. |
| `REVIEWER_DISABLED` | 401, 403 | Reviewer interface is disabled. | Panel recenzenta jest wyłączony. |
| `SAME_INGREDIENT` | 400 | An ingredient cannot take its own place. Choose another one. | Składnik nie może zastąpić samego siebie. Wybierz inny. |
| `SCALE_OUT_OF_RANGE` | 400 | That would leave a meal with less than half a serving or more than three. | Posiłek miałby wtedy mniej niż pół porcji albo więcej niż trzy. |
| `SECOND_FACTOR_ALREADY_ON` | 409 | Two-step sign-in is switched on already. Switch it off before you set it up again. | Logowanie dwuetapowe jest już włączone. Wyłącz je, zanim skonfigurujesz je ponownie. |
| `SECOND_FACTOR_NOT_FOUND` | 404 | No account with that address uses two-step sign-in. | Żadne konto z tym adresem nie używa logowania dwuetapowego. |
| `SECOND_FACTOR_NOT_ON` | 409 | Two-step sign-in is not switched on. | Logowanie dwuetapowe nie jest włączone. |
| `SECOND_FACTOR_SETUP_EXPIRED` | 400 | This set-up has run out. Begin again. | Ta konfiguracja wygasła. Zacznij od nowa. |
| `SERVER_BUSY` | 503 | The server is busy right now. Try again in a moment. | Serwer jest teraz zajęty. Spróbuj ponownie za chwilę. |
| `SESSION_JUST_REFRESHED` | 409 | Your session was refreshed in another tab a moment ago. Try again. | Sesja została przed chwilą odświeżona w innej karcie. Spróbuj ponownie. |
| `SESSION_NOT_FOUND` | 404 | That session is no longer open. | Ta sesja nie jest już otwarta. |
| `SET_NOT_FOUND` | 404 | Favourite set not found. | Nie znaleziono zestawu ulubionych. |
| `SHIP_NO_APPROVED` | 409 | No approved drafts to ship. | Brak zatwierdzonych szkiców do wysłania. |
| `SHIP_REPO_ROOT_NOT_FOUND` | 409 | Could not find the git repo root for the upstream PR mode. | Nie znaleziono katalogu .git potrzebnego do wysyłki przez pull request. |
| `SHIP_UPSTREAM_BLOCKED_CANONICAL` | 409 | The configured remote points at the canonical diet-app repo. AI-drafted content never pushes there — even from the maintainer instance. Point SHIP_UPSTREAM_REMOTE at a private mirror, or use the local / bundle ship modes. | Skonfigurowane zdalne repozytorium to główne repozytorium diet-app. Treść napisana przez AI nigdy tam nie trafia — nawet z instancji opiekuna projektu. Ustaw SHIP_UPSTREAM_REMOTE na prywatną kopię repozytorium albo wyślij szkice do tej instancji lub jako paczkę. |
| `SHIP_UPSTREAM_DISABLED` | 409 | Upstream PR mode is disabled on this instance. | Wysyłka przez pull request jest wyłączona na tej instancji. |
| `SHIP_UPSTREAM_NO_TOKEN` | 409 | Upstream PR mode is missing a gh token. | Brakuje tokenu gh do wysyłki przez pull request. |
| `SHOPPING_LIST_LIMIT` | 409 | This plan already has as many shopping lists as it can hold. Delete one first. | Ten plan ma już tyle list zakupów, ile może mieć. Najpierw usuń jedną z nich. |
| `SHOPPING_RANGE_OUTSIDE_PLAN` | 400 | Those dates are not within the plan. Pick dates the plan covers. | Te daty nie mieszczą się w planie. Wybierz daty, które plan obejmuje. |
| `SUBSTITUTION_MOVES_NUTRITION` | 422 | This substitution changes what a serving holds by more than a tenth. Confirm that you want it all the same. | Ta zamiana zmienia wartości porcji o więcej niż jedną dziesiątą. Potwierdź, że mimo to chcesz ją wykonać. |
| `TOO_MANY_ATTEMPTS` | 429 | Too many failed sign-ins. Wait a moment before you try again. | Zbyt wiele nieudanych prób logowania. Odczekaj chwilę, zanim spróbujesz ponownie. |
| `TRANSLATIONS_IN_PROGRESS` | 409 | A run that fills a missing language is already in progress. | Uzupełnianie brakującego języka już trwa. |
| `TURNSTILE_FAILED` | 400 | Anti-abuse check failed. Please try again. | Weryfikacja chroniąca przed nadużyciami nie powiodła się. Spróbuj ponownie. |
| `UNAUTHORIZED` | 401 | Sign in to continue. | Zaloguj się, aby kontynuować. |
| `UNIT_CONVERSION_FAILED` | 400 | Could not convert the recipe's quantities — missing density or grams-per-piece. | Nie udało się przeliczyć jednostek — brak gęstości lub gramów na sztukę. |
| `UNIT_NOT_CONVERTIBLE` | 400 | This ingredient can't be kept in that unit. Use the unit it is weighed or measured in. | Tego składnika nie można trzymać w tej jednostce. Użyj jednostki, w której się go waży lub mierzy. |
| `UNKNOWN_SLUG` | 400 | Ingredient slug not found in the curated catalogue. | Składnik nie istnieje w katalogu — podaj inny slug. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The server does not accept that format. | Serwer nie obsługuje tego formatu. |
| `UPDATE_IN_PROGRESS` | 409 | A database update is already in progress. | Aktualizacja bazy już trwa. |
| `USER_NOT_FOUND` | 404 | Account not found. | Nie znaleziono konta. |
| `VALIDATION_FAILED` | 400 | Some fields need attention. | Niektóre pola wymagają poprawy. |
| `VERIFICATION_SENT_RECENTLY` | 429 | A verification mail was sent a moment ago. Look for it, or ask again in a couple of minutes. | Wiadomość z linkiem potwierdzającym została wysłana przed chwilą. Sprawdź skrzynkę albo poproś ponownie za parę minut. |
| `WEIGHT_ENTRY_NOT_FOUND` | 404 | Weight entry not found. | Nie znaleziono wpisu wagi. |
| `WRITE_CONFLICT` | 409 | The data changed while the request was running. Try again. | Dane zmieniły się w trakcie operacji. Spróbuj ponownie. |
