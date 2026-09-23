# Moonlight public release scope

User approved visual direction and explicitly authorized completing, testing and publicly releasing through the existing channel. Vietnamese is the default with full English option. Keep the approved Overview geometry and all 10 themes. Work only in this isolated worktree; preserve unrelated canonical changes, never force-push.

## Product

- Overview remains the approved composition, with translated navigation, states, actions and console. Theme emblem follows active theme (rabbit only for Mid-Autumn).
- Access, Execution, Devices, Updates and Settings become dedicated full-width workspace pages with page heading, short explanatory copy, responsive glass sections, clear primary actions and grouped secondary/danger actions. Dialogs are reserved for details, theme selection and focused interactions.
- Every existing owner HTTP capability needed by these pages stays reachable and correctly wired, including onboarding, recovery, runtime lifecycle, UAC/admin approval, scopes/leases, providers, pairing, multi-node and updater. No arbitrary shell or permission bypass. Unsupported capabilities say unavailable honestly.
- Vietnamese default, English switch, browser-local preference. Translate visible UI, dialog titles, confirmations, toasts, aria labels, status labels and theme copy. Do not translate machine identifiers, command output or alter API payload enum values.
- Complete functional/security/browser verification; build and inspect installation package with all assets/fonts/modules. Publish through actual repository release workflow only after all gates pass; report precise version and links. User already authorized publishing.

## Shared frontend contracts

Parent owns `assets/moonlight/i18n.js`: exports `registerTranslations(dict)`, `t(source, params={})`, `getLanguage()`, `setLanguage('vi'|'en')`, `onLanguageChange(callback)`. `dict` maps English source strings to Vietnamese translations; placeholders `{name}` are interpolated for either locale. Default vi, localStorage key `moonlight-language`, no secrets. Registration occurs via imports, before render. Unknown source returns source unchanged. Do not use DOM mutation-observer translation or translate backend data by blanket document replacement.

Shell agent owns `app.js`, `index.html`, `model.js`, `themes.js`, and NEW `translations-shell.js`.
Views agent owns `views.js`, `integration.css`, NEW `translations-views.js`, and its focused tests.
Parent owns server allowlist/module routing, locale core, integration tests, release orchestration, overall verification.

`createViews({api,store,openModal,openPage,toast,refresh})` maintains existing exports. `openPage(page,title,HTMLElement)` renders a secondary page and returns its content root; `page` is existing English navigation ID. Shell creates the page shell, hides Overview for secondary pages, manages nav state and routes, and reopens the active secondary page on language changes. Views use openPage for the five navigation pages, openModal for notifications/profile/device detail. Existing API/store shapes unchanged.

No competing writes to other agent files. All agents share the worktree; accommodate other's changes.
