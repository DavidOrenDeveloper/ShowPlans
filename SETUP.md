# הפעלת הענן – שלב 1 (פעם אחת)

> הערכים הציבוריים (כתובת Supabase, המפתח הציבורי) כבר ב-`js/config.js`. הסודות לא נמצאים בקוד.

## 1. מסד הנתונים
Supabase ← SQL Editor ← הדביקו את כל `supabase/schema.sql` והריצו. (בטוח להריץ שוב.)

## 2. חשבון המנהל
1. Authentication ← Users ← Add user ← אימייל + סיסמה, לסמן **Auto Confirm User**.
2. Authentication ← Sign In / Providers ← לכבות **Allow new users to sign up** (שרק אתה תיצור עובדים).
3. ב-SQL Editor:
   `update public.profiles set role = 'admin' where email = 'האימייל-שלך';`

## 3. Secrets לפונקציות (Project Settings ← Edge Functions ← Secrets)
| שם | ערך |
|---|---|
| `GOOGLE_CLIENT_ID` | ה-Client ID של גוגל |
| `GOOGLE_CLIENT_SECRET` | ה-Client secret |
| `GOOGLE_REFRESH_TOKEN` | ה-refresh token של ה-Gmail הייעודי (הרשאה `drive.file`) |
| `DRIVE_FOLDER_ID` | `1FXLBe7p357HKd3R150jJ6WGD3RBsmgTU` |
| `ALLOWED_ORIGINS` | `https://davidorendeveloper.github.io` (אפשר לרשום כמה, מופרדים בפסיק) |
| `PUBLISHABLE_KEY` | המפתח הציבורי `sb_publishable_…` (רק אם `SUPABASE_ANON_KEY` לא מוזרק אוטומטית) |

`SUPABASE_URL` ו-`SUPABASE_SERVICE_ROLE_KEY` מוזרקים אוטומטית. **לא להעביר אותם לאף אחד.**

## 4. פריסת הפונקציות
במחשב, בתיקיית הפרויקט (דורש Supabase CLI):
```
supabase login
supabase link --project-ref yokgltxcmnfgwygvecnc
supabase functions deploy drive-download drive-upload-session admin-users --no-verify-jwt
```

## 5. מניעת השבתה אחרי שבוע
ב-GitHub ← Settings ← Secrets and variables ← Actions: `SUPABASE_URL` ו-`SUPABASE_PUBLISHABLE_KEY`.
הקובץ `.github/workflows/keepalive.yml` ירוץ פעם ביום. (GitHub מכבה workflows מתוזמנים אחרי ~60 יום בלי commit; אז מפעילים אותו ידנית בלשונית Actions.)

## 6. העלאת האפליקציה
מעלים את כל הקבצים ל-GitHub Pages (כולל `sw.js`, `manifest.webmanifest`, `lib/supabase.js`).

## 7. בדיקה ראשונה
1. כניסה כמנהל ← "עובדים" בתפריט הצד ← יצירת עובד.
2. העלאת PDF ← מחכים לכתובת "מסונכרן" ← בודקים שהקובץ הופיע בתיקיית ה-Drive.
3. כניסה מטלפון אחר עם אותו משתמש ← התוכנית מופיעה, ונפתחת (מורידה מהענן).
4. תיקייה/תוכנית ← ⋮ ← "הרשאות עובדים…" ← בחירת רמה לעובד. כניסה כעובד ובדיקה שהוא רואה רק את זה.

## מה עובד ומה עוד לא (שלב 1)
- ✔ כניסה, מנהל/עובד, תיקיות/תוכניות/גרסאות מסונכרנות, קבצי PDF ב-Drive, הרשאות (RLS), ניהול עובדים, עבודה בלי אינטרנט עם סנכרון חוזר.
- ✘ **סימונים, מדידות, כיולים וקישורים עדיין לא מסונכרנים** (שלב 2; הטבלה וכללי ההרשאה שלהם כבר בסכמה).
- ✘ הורדה מראש "לשימוש ללא אינטרנט" לתיקייה (שלב 3). עכשיו כל תוכנית שנפתחה נשמרת במכשיר.
- ✘ גיבוי/שחזור (ZIP) לא מותאם לענן: שחזור במצב ענן לא מעלה לענן.
- ✘ מחיקת קבצים מ-Drive: מחיקת תוכנית בענן מסמנת אותה כמחוקה ומסירה אותה מכולם, אבל קובץ ה-PDF נשאר בתיקיית ה-Drive (אפשר למחוק ידנית).
- ⚠ **לא נבדק מול Supabase ו-Google האמיתיים** (רק מול סימולציה ו-PostgreSQL מקומי). הבדיקה הראשונה אצלך היא הבדיקה האמיתית, במיוחד העלאה ישירה ל-Drive (CORS).
