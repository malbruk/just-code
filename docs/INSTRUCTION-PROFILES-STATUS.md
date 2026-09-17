# מצב עבודה: פרופילי עבודה ופרומפטי הנחיה (branch: `feature/instruction-profiles`)

מסמך סטטוס לנקודת עצירה באמצע עבודה. נכתב 2026-09-17. מיועד למי שממשיך את העבודה (אדם או סשן Claude חדש).

## הצורך (למה הפיצ'ר קיים)

התוסף "Just Code" נועד לאפשר עבודה טכנית בלבד, בהתאם לסטנדרטים חרדיים שמרניים. ההגנה המקורית הייתה system prompt יחיד עם סירוב גורף — וזה יצר שתי בעיות הפוכות:

1. **הגנה לא מספקת:** בקשה במעטפת מקצועית ("אני מפתחת וקיבלתי פרויקט לבנות דף נחיתה לשחקנית") עברה את הסינון, והתוסף ייצר תוכן בעייתי.
2. **חסימת-יתר:** סירוב גורף לכל תוכן לא-טכני חוסם גם עבודה לגיטימית — דפי HTML עם טקסט שיווקי, sample data, UI copy — שהם חלק אמיתי מהעבודה.

הפתרון שנבחר: **Sanitize, don't block** — לבנות את הארטיפקט הטכני המלא, אבל להחליף כל תוכן שאינו עומד בסטנדרט ב-placeholders ניטרליים (לורם איפסום / טקסט עסקי גנרי), עם משפט יידוע אחד וללא הטפות. בנוסף: **תוכן של המשתמש הוא מחוץ לתחום המדיניות** — טקסט קיים בקבצים או שסופק בשיחה נשמר תמיד מילה במילה (redesign/refactor לא "מצנזר" תוכן קיים).

מעבר לכך, הארכיטקטורה הוכללה לשתי שכבות כדי לתמוך בעתיד בתחומי עבודה נוספים (הנהלת חשבונות וכו'):

- **פרופיל עבודה (profile)** — תחום עבודה (כרגע רק `coding`); בדיוק אחד פעיל; ה-system prompt שלו חל על כל שיחה חדשה.
- **פרומפט הנחיה (prompt)** — סט הנחיות לפי-דרישה תחת פרופיל (כרגע רק `code-content-sanitization`), שמופעל דרך זרימת אישור בצ'אט.

## מה בוצע (נמצא ב-branch הזה)

הארכיטקטורה המלאה מתועדת ב-`CLAUDE.md` (סעיף `agent/instructions/`). בקצרה:

- **תוכן** — `src/agent/prompts/`:
  - `system-prompt.md` — ה-append הבסיסי, עקרונות כלליים ניטרליים-לערוץ + סקציות מסומנות-markers שמורכבות דינמית (`{{PROFILE_SECTION}}`, `{{INSTRUCTION_PROMPTS_SECTION}}`, `{{ACTIVE_PROMPTS_SECTION}}`).
  - `profiles/coding/profile.md` — פרופיל coding (frontmatter בסגנון SKILL.md: name/description + body = system prompt).
  - `profiles/coding/code-content-sanitization.md` — פרומפט הסניטיזציה: קטגוריות התוכן המוגבל, נוהל ההחלפה ב-placeholders, כלל "User content is inviolable", וסעיף anti-bypass.
  - הוספת פרופיל/פרומפט חדש = הוספת קובץ `.md` בלבד + build (ה-registry גנרי).
- **Host** — `src/agent/`:
  - `instructions/registry.ts` — סריקה גנרית של עץ הפרופילים מ-`dist/prompts/profiles` בזמן ריצה (esbuild מעתיק בכל build; `.vscodeignore` משאיר את `dist/**` ב-VSIX).
  - `instructions/server.ts` — שרת MCP in-process עם כלי `load_instructions` שהוא **סיגנל בלבד**: טקסט פרומפט לעולם לא עובר ב-tool result (ערוץ לא-אמין), אלא רק ב-system prompt append אחרי restart עם `resume`.
  - `tools/permissions.ts` — יירוט הקריאה בכל המצבים, כרטיס אישור (activate / always / cancel), auto-activation, ומסלול plumbing-deny.
  - `sessionManager.ts` — `applyPrompt`: סימון הפרומפט כפעיל, restart של ה-query עם resume, הזרקת הטקסט המלא ל-append, ו-resend שקוף של ההודעה שנקטעה.
  - `config.ts` + `package.json` — ארבע הגדרות application-scoped: `instructionsMode` (base/profiles), `activeProfile`, `instructionPrompts` (מפת enable), `autoActivatePrompts`.
- **Webview** — `webview-ui/src/instructions.ts` — דיאלוג `/instructions` (כפתור מגן ב-header): מתג Base/Profile, בחירת פרופיל, checkboxes לפרומפטים + auto. עדכוני `render.ts`, `main.ts`, `icons.ts`, `webview.css`, `protocol.ts`.
- **תיעוד** — `CLAUDE.md` ו-`README.md` עודכנו לתאר את הפיצ'ר.

### מצב אימות בנקודת העצירה (כולם הורצו עכשיו)

| בדיקה | תוצאה |
|---|---|
| `npx tsc --noEmit` | ✅ נקי |
| `node esbuild.js` | ✅ שני ה-bundles נבנים |
| `scratch/activate-test.js` | ✅ |
| `scratch/instructions-registry-test.mjs` | ✅ |
| `scratch/profile-activation-test.js` | ✅ |
| `scratch/instructions-dialog-test.mjs` | ✅ |
| `scratch/slash-usage-test.js` | ❌ 4 כשלונות — כולם על `/rewind` (ראו למטה) |
| `scratch/instructions-tool-test.mjs` | ⚠️ לא הורץ (בדיקה חיה, מחייבת query אמיתי) |
| `scratch/content-preservation-test.mjs` | ⚠️ לא הורץ (חי ולא-דטרמיניסטי; חובה אחרי כל שינוי בטקסט פרומפט) |

## מה עדיין לא בוצע / להמשיך מכאן

1. **פקודת `/rewind` בצ'אט (העבודה הפתוחה היחידה בקוד).** תשתית ה-rewind קיימת וכבר בקומיטים קודמים (`protocol.ts` — הודעת `rewind`, כפתור ב-composer, `SessionManager.rewind`), אבל פקודת ה-slash חסרה. `scratch/slash-usage-test.js` (ה-scratch מקומי, לא ב-git) כבר מכיל 4 assertions שמגדירים את ההתנהגות הצפויה:
   - יירוט client-side של `/rewind` ב-`SessionManager.handleMessage` (ניקוי busy, בלי לפתוח turn);
   - הודעת "nothing to rewind" כשאין שיחה;
   - הוספת `/rewind` לרשימת ההשלמות ב-`src/context/completions.ts` (ממוין אלפביתית).
2. **הרצת שתי הבדיקות החיות** (`instructions-tool-test.mjs`, `content-preservation-test.mjs`) — חובה לפני release, כי טקסטי הפרומפטים שונו.
3. **בדיקה ידנית ב-Extension Development Host (F5):** זרימת כרטיס ההפעלה מקצה לקצה, דיאלוג `/instructions` (כולל RTL/bidi בעברית), auto-activation, והתנהגות אחרי resume.
4. **אריזת VSIX ואימות** ש-`dist/prompts/profiles` באמת נכנס לחבילה (`npm run vsix` ואז לבדוק את תוכן ה-vsix), והתקנה ידנית לפני הכרזה שהפיצ'ר עובד.
5. **פרופילים נוספים** (למשל הנהלת חשבונות) — שינוי תוכן בלבד: תיקיית `profiles/<id>/` עם `profile.md` ופרומפטים. לא נדרש קוד.
6. **החלטה על `AGENTS.md`** — קיים בעץ קובץ לא-מקומט שנוצר ככל הנראה ע"י סקריפט find-replace‏ (`scratch/rebrand.js`) שהחליף "Claude Code"→"Codex" בתוך העתק של `CLAUDE.md`, כולל טקסט שבור ("Codex Agent SDK"). הושאר מחוץ ל-git בכוונה — לתקן או למחוק.
7. **לפני release:** עדכון גרסה + `CHANGELOG.md`, ואז זרימת ה-release הרגילה.

## איך ממשיכים בפועל

```
git checkout feature/instruction-profiles
npm install
npm run check-types && node esbuild.js
node scratch/slash-usage-test.js   # 4 הכשלונות של /rewind הם נקודת ההתחלה
```
