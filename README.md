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

### Tester sans accéder à la production

`npm run web` lance le registre hors ligne dans le navigateur. `npm start` lance le même mode pour les simulateurs iOS et Android ou pour un client Expo compatible sur téléphone. Les données de test ont leur propre espace de stockage pour les véhicules, les bons et les brouillons. Le démarrage de développement choisit ce mode par défaut, y compris si le fichier `.env.local` contient la configuration de production.

Pour tester la connexion, les rôles, les photos privées et le MFA, utilise Docker et le [CLI Supabase local](https://supabase.com/docs/guides/local-development/cli/getting-started).

```bash
npx supabase start
npx supabase status
cp .env.parko-test.example .env.parko-test.local
```

Dans `.env.parko-test.local`, remplace la clé fictive par la clé publiable affichée par le Supabase local. Garde l’adresse `http://127.0.0.1:54321` et le parking de test du modèle.

```bash
npm run test:local
npm run test:permissions
```

Les comptes fictifs sont `agent@parko.example`, `responsable@parko.example` et `externe@parko.example`. Leur mot de passe local est `Parko-Local-2026!`. Avec le MFA obligatoire, le test vérifie que le mot de passe seul ne donne accès ni au registre ni aux opérations. Pour repartir à neuf, `npx supabase db reset --local` efface la base de test et rejoue les migrations et le seed.

Pour ouvrir ce même registre dans un simulateur iOS ou un émulateur Android équipé d’un build de développement compatible, lance `node scripts/start-local.mjs local` et choisis `i` ou `a` dans Expo. Pour Android, utilise `http://10.0.2.2:54321` dans `.env.parko-test.local` et remets l’adresse `127.0.0.1` pour les tests Web et `test:permissions`. Le mode Supabase local accepte les adresses de boucle locale et l’adresse spéciale de l’émulateur Android. Sur un téléphone physique, utilise le mode hors ligne pour les tests d’interface.

Le parking de test exige le MFA pour tous ses membres. Reconnecte-toi comme agent ou responsable, clique sur **Configurer l’application d’authentification**, scanne le QR code, puis saisis le code à six chiffres. Si tu utilises le même téléphone pour les deux applications, choisis **Afficher la clé manuelle**. Le compte externe reste exclu du parking.

Pour appliquer cette politique à une base locale créée avec un ancien seed, exécute la requête suivante dans **SQL Editor** du Studio local.

```sql
update public.parkings
set mfa_policy = 'all'
where id = '10000000-0000-4000-8000-000000000001';
```

Sur une instance locale jetable, la politique `optional` permet d’exécuter le scénario automatisé complet des opérations avec des comptes sans second facteur. Ce scénario crée une fiche et une photo fictives pour vérifier les droits de lecture, l’annulation, le retrait d’une prestation et le journal d’audit. En cas de perte de l’application d’authentification, un administrateur vérifie l’identité avant de réinitialiser le facteur concerné dans Supabase.

### Sauvegarde et restauration de test

Le [tutoriel technicien de sauvegarde et restauration](docs/sauvegarde-et-restauration.md) détaille les opérations sur Supabase local et en ligne, le chiffrement et les contrôles après restauration.

Installe un client PostgreSQL compatible avec le serveur local. Crée un fichier ignoré `.env.parko-backup.local` avec la clé serveur **locale** et, si nécessaire, les adresses locales affichées par le CLI.

```dotenv
PARKO_LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
PARKO_LOCAL_STORAGE_URL=http://127.0.0.1:54321
PARKO_LOCAL_STORAGE_ADMIN_KEY=cle_serveur_du_projet_local
```

`npm run backup:local` écrit un fichier `registre.dump`, un dossier `photos` conservant les chemins et un inventaire dans `backups/parko-local-*`, en dehors du dossier Web `dist`. Le script est limité à la boucle locale. Le code de l’application utilise uniquement la clé publiable.

Pour le test de restauration, utilise une instance Supabase locale jetable, au même niveau de migration et avec les mêmes comptes fictifs. Avec `pg_restore --list registre.dump`, sélectionne les lignes `TABLE DATA` des tables applicatives `public.parkings` et `public.parking_*` et la ligne `SEQUENCE SET` de `parking_audit_id_seq` dans un fichier `registre.list`. Vide ces tables dans la base jetable, puis restaure leurs données avec `pg_restore --data-only --disable-triggers --single-transaction --use-list registre.list --dbname "$PARKO_RESTORE_DB_URL" registre.dump`. `PARKO_RESTORE_DB_URL` doit être l’adresse PostgreSQL affichée par le CLI de cette instance locale. Les déclencheurs restent actifs lors de l’utilisation ordinaire. Recopie ensuite les fichiers dans le bucket privé `parko-plates` en conservant leurs chemins. Vérifie les compteurs, un bon, une prestation et la lecture d’une photo avec un agent de test.

Pour une sauvegarde réelle, suis la procédure de ton environnement, notamment pour les utilisateurs Auth. Chiffre séparément la base et les photos avant de les transférer hors du projet. Conserve les clés de chiffrement séparément. [Guide de restauration Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

### Avant une future mise en ligne

- Vérifier les accès anonymes et externes sur le projet concerné, le bucket privé et la désactivation de l’inscription publique. Activer le MFA des administrateurs Supabase, Cloudflare et GitHub et conserver les codes de récupération dans un coffre. Vérifier la configuration du build et remplacer toute clé privée exposée.
- Tester une restauration avant de migrer le registre partagé. Prévoir une mise à jour coordonnée de l’application et de la migration 011. Attribuer explicitement au moins un rôle `responsable` par parking via le tableau de bord administrateur avant de rouvrir la facturation. Les membres existants reçoivent le rôle `agent`. Les agents voient leurs propres prestations sur les fiches et les rapports globaux de prestations sont réservés aux responsables.
- Tester les en-têtes de `public/_headers` sur un déploiement de test. La politique CSP est en mode rapport pour vérifier les connexions Supabase, les photos, l’import PDF et l’impression avant de la rendre bloquante.
- Fixer les durées de conservation et la liste des destinataires des photos, bons, journaux et exports. Définir les modalités de partage, de suppression et de conservation des sauvegardes avec le responsable du parking et les adapter aux obligations applicables.
