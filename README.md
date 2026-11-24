# PARKO

## Registre partagé

Appliquer les migrations dans `supabase/migrations` dans l’ordre, puis configurer les variables suivantes dans l’environnement Expo utilisé pour le build.

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_PARKING_ID`

Les profils EAS `preview` et `production` exigent cette configuration. Pour un export Web partagé, définir aussi `EXPO_PUBLIC_REQUIRE_SHARED_REGISTER=true` avant de lancer `npx expo export --platform web`. Héberger le dossier `dist` en HTTPS. Sur iPhone, le site peut être ajouté à l’écran d’accueil depuis Safari.

Le profil EAS `preview` produit un APK Android pour la distribution interne. La distribution native ad hoc sur iPhone nécessite une adhésion Apple Developer.

## Vérifications locales

```bash
npm ci
npm run lint
npm run typecheck
npm test
```
