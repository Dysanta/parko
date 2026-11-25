# Sauvegarde et restauration de PARKO

Ce tutoriel s’adresse au technicien qui exploite PARKO sur Supabase. Avant chaque migration, crée un lot contenant deux archives chiffrées du même horodatage. La première contient la base PostgreSQL. La seconde contient les photos du bucket privé `parko-plates`. Valide la restauration dans une instance de test avant d’utiliser ce lot comme point de retour. [Sauvegardes Supabase](https://supabase.com/docs/guides/platform/backups)

## Préparer l’intervention

1. Identifie le projet source, le projet de test et le parking concerné. Note leurs références et le chemin de conservation des archives dans le journal d’intervention.
2. Planifie la sauvegarde à la fermeture du parking ou suspends temporairement les saisies pendant l’export de la base et la copie des photos. Les deux opérations se déroulent séparément.
3. Démarre Docker Desktop. Dans le terminal Ubuntu et depuis le dépôt PARKO, vérifie `docker info` et `npx supabase --version`. Installe les outils ci-dessous si nécessaire. Pour un dump local, utilise une version de `pg_dump` au moins égale à celle du serveur PostgreSQL.

```bash
sudo apt update
sudo apt install postgresql-client awscli age file
pg_dump --version
aws --version
age --version
```

Les commandes des sections sauvegarde, chiffrement et restauration utilisent des variables de terminal. Exécute chaque section dans le terminal où tu as défini ses variables. En cas d’erreur, arrête la procédure et corrige la cause avant de poursuivre.

## Sauvegarder le projet en ligne

### Exporter la base

1. Dans le projet source, ouvre **Connect**. Copie la chaîne **Direct connection** si elle est joignable, ou **Session pooler**. Renseigne le mot de passe PostgreSQL dans la chaîne et encode les caractères réservés pour l’URL. Vérifie la référence du projet avant l’export. [Connexions et export PostgreSQL](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
2. Dans Ubuntu, crée un dossier de travail privé sur un volume chiffré. Colle la chaîne à l’invite du terminal. Le script réalise les trois exports et consigne la version du dépôt.

```bash
cd "$HOME/Parking app"
umask 077
PARKO_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PARKO_WORK=$(mktemp -d "$HOME/parko-travail-${PARKO_STAMP}-XXXXXX")
mkdir -p "$PARKO_WORK/base" "$PARKO_WORK/photos"

(
  set -e
  read -rsp 'Chaîne PostgreSQL du projet SOURCE : ' PARKO_DB_URL
  printf '\n'
  npx supabase db dump --remote="$PARKO_DB_URL" --role-only -f "$PARKO_WORK/base/roles.sql"
  npx supabase db dump --remote="$PARKO_DB_URL" -f "$PARKO_WORK/base/schema.sql"
  npx supabase db dump --remote="$PARKO_DB_URL" --data-only --use-copy \
    -x storage.objects -x storage.buckets_vectors -x storage.vector_indexes \
    -f "$PARKO_WORK/base/data.sql"
  git rev-parse HEAD > "$PARKO_WORK/base/version-git.txt"
  test -s "$PARKO_WORK/base/schema.sql"
  test -s "$PARKO_WORK/base/data.sql"
  printf 'Export PostgreSQL terminé dans %s/base\n' "$PARKO_WORK"
)
```

Vérifie le message de fin et l’existence des trois fichiers. `roles.sql` peut être vide si le projet n’a aucun rôle PostgreSQL personnalisé. L’export exclut `storage.objects` pour permettre à Storage de recréer les entrées lors du téléversement. Les identifiants du registre nécessaires pour retrouver les photos restent dans PostgreSQL. Conserve en Git les migrations exactes déjà appliquées au projet source. [Options de `supabase db dump`](https://supabase.com/docs/reference/cli/introduction#supabase-db-dump)

### Copier les photos

1. Dans **Storage → S3** du projet source, relève l’endpoint et la région, puis crée une paire de clés S3 dédiée. Ces clés donnent accès aux buckets avec des droits étendus. Utilise-les uniquement sur le poste de sauvegarde ou dans un coffre administré. [Clés S3 de Supabase](https://supabase.com/docs/guides/storage/s3/authentication)
2. Configure le profil `parko-source` lors du premier passage, puis copie le bucket et compare les compteurs.

```bash
aws configure --profile parko-source
aws configure set s3.addressing_style path --profile parko-source
read -rp 'Endpoint S3 du projet SOURCE : ' PARKO_S3_ENDPOINT

(
  set -euo pipefail
  aws --profile parko-source --endpoint-url "$PARKO_S3_ENDPOINT" \
    s3 sync s3://parko-plates/ "$PARKO_WORK/photos/" --only-show-errors
  aws --profile parko-source --endpoint-url "$PARKO_S3_ENDPOINT" \
    s3 ls s3://parko-plates/ --recursive --summarize | tail -n 2
  find "$PARKO_WORK/photos" -type f -printf '.' | wc -c
)
```

Compare **Total Objects** avec le nombre de fichiers locaux. Note ce total et les compteurs SQL de la section de vérification avant de reprendre les saisies. Le chemin `parking_id/visite_id` doit être conservé à l’identique, y compris pour les fichiers sans extension. [Copie récursive AWS CLI](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html) · [Chemins des photos PARKO](../cloudRegister.ts#L122)

## Sauvegarder le Supabase local

Depuis le dépôt, lance `npx supabase status`. Crée `.env.parko-backup.local` à la racine et copie la clé **Secret** du Supabase local dans `PARKO_LOCAL_STORAGE_ADMIN_KEY`. Vérifie que l’API et PostgreSQL utilisent les ports `54321` et `54322`. Ce sont les ports acceptés par le script de PARKO.

```dotenv
PARKO_LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
PARKO_LOCAL_STORAGE_URL=http://127.0.0.1:54321
PARKO_LOCAL_STORAGE_ADMIN_KEY=REMPLACER_PAR_LA_CLE_SERVEUR_LOCALE
```

```bash
chmod 600 .env.parko-backup.local
npm run backup:local
```

Le dossier `backups/parko-local-*` affiché contient `registre.dump`, `photos/` et `inventaire.json`. Compare le nombre de photos de l’inventaire avec le contenu du bucket local. Pour chiffrer ce lot, prépare le dossier ci-dessous en indiquant le chemin affiché par le script. [Script de sauvegarde locale](../scripts/backup-local.mjs)

```bash
umask 077
read -erp 'Chemin du dossier parko-local créé par le script : ' PARKO_LOCAL_BACKUP
PARKO_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PARKO_WORK=$(mktemp -d "$HOME/parko-travail-${PARKO_STAMP}-XXXXXX")
mkdir -p "$PARKO_WORK/base"
cp "$PARKO_LOCAL_BACKUP/registre.dump" "$PARKO_LOCAL_BACKUP/inventaire.json" "$PARKO_WORK/base/"
cp -R "$PARKO_LOCAL_BACKUP/photos" "$PARKO_WORK/photos"
```

## Chiffrer et mettre le lot hors site

Sur un poste de restauration, génère une seule fois la paire de clés. Range le fichier `restauration.agekey` dans le coffre réservé à la restauration. Distribue uniquement `destinataire.txt` au poste de sauvegarde. [Documentation `age`](https://github.com/FiloSottile/age/blob/main/doc/age.1.html)

```bash
umask 077
age-keygen -o restauration.agekey
age-keygen -y restauration.agekey > destinataire.txt
```

Sur le poste de sauvegarde, indique le chemin du fichier contenant la clé publique et choisis ton dossier de sortie.

```bash
read -erp 'Chemin de destinataire.txt : ' PARKO_RECIPIENTS
PARKO_ARCHIVES="$HOME/parko-archives-chiffrees"
mkdir -p "$PARKO_ARCHIVES"

(
  set -euo pipefail
  test -d "$PARKO_WORK/base"
  test -d "$PARKO_WORK/photos"
  tar -C "$PARKO_WORK" -czf - base | age -R "$PARKO_RECIPIENTS" \
    -o "$PARKO_ARCHIVES/parko-base-$PARKO_STAMP.tar.gz.age"
  tar -C "$PARKO_WORK" -czf - photos | age -R "$PARKO_RECIPIENTS" \
    -o "$PARKO_ARCHIVES/parko-photos-$PARKO_STAMP.tar.gz.age"
  cd "$PARKO_ARCHIVES"
  sha256sum "parko-base-$PARKO_STAMP.tar.gz.age" \
    "parko-photos-$PARKO_STAMP.tar.gz.age" > "parko-$PARKO_STAMP.sha256"
)
```

Copie les deux fichiers `.age` et le fichier `.sha256` sur un support distinct ou un espace de sauvegarde privé. Dans ce dossier de destination, exécute `sha256sum -c "parko-$PARKO_STAMP.sha256"` et vérifie que les deux lignes indiquent **OK**. Conserve la clé privée séparément des archives. Après validation du lot, retire les copies de travail en clair du poste de sauvegarde.

## Ouvrir un lot pour la restauration

Depuis un dossier contenant les trois fichiers du lot, saisis l’horodatage présent dans leurs noms et le chemin de la clé privée. Cette étape vérifie et extrait les deux archives sur un volume chiffré.

```bash
umask 077
read -rp 'Horodatage du lot : ' PARKO_STAMP
read -erp 'Chemin de la clé privée age : ' PARKO_IDENTITY
PARKO_RESTORE=$(mktemp -d "$HOME/parko-restauration-XXXXXX")

(
  set -euo pipefail
  sha256sum -c "parko-$PARKO_STAMP.sha256"
  age -d -i "$PARKO_IDENTITY" "parko-base-$PARKO_STAMP.tar.gz.age" |
    tar -xzf - -C "$PARKO_RESTORE"
  age -d -i "$PARKO_IDENTITY" "parko-photos-$PARKO_STAMP.tar.gz.age" |
    tar -xzf - -C "$PARKO_RESTORE"
)
```

## Restaurer le lot en ligne dans un projet de test

1. Crée un projet Supabase de test vide avec accès limité. Active les extensions utilisées sur le projet source. Relève son identifiant de projet et utilise sa propre chaîne PostgreSQL. Pour un projet qui utilise Supabase Vault ou des colonnes chiffrées, traite le transfert de la clé de chiffrement selon la procédure Supabase avant l’import. [Préparer le projet de restauration](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore#restore-backup-using-cli)
2. Saisis la référence du projet de test, puis sa chaîne de connexion. Le garde-fou vérifie la présence de cette référence dans le nom d’hôte direct ou dans l’identifiant du Session pooler. Vérifie aussi visuellement la référence dans le tableau de bord du projet de test.

```bash
(
  set -euo pipefail
  read -rp 'Référence du projet Supabase de TEST : ' PARKO_TEST_REF
  [[ "$PARKO_TEST_REF" =~ ^[a-z0-9]{20}$ ]] || exit 1
  read -rsp 'Chaîne PostgreSQL du projet de TEST : ' PARKO_TEST_DB_URL
  printf '\n'
  case "${PARKO_TEST_DB_URL%%\?*}" in
    *@db."$PARKO_TEST_REF".supabase.co:5432/postgres|postgresql://postgres."$PARKO_TEST_REF":*@*.pooler.supabase.com:5432/postgres) ;;
    *) printf 'Référence de test non reconnue dans la chaîne PostgreSQL.\n' >&2; exit 1 ;;
  esac

  psql --no-psqlrc --single-transaction --set ON_ERROR_STOP=1 \
    --file "$PARKO_RESTORE/base/roles.sql" \
    --command 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated; ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;' \
    --file "$PARKO_RESTORE/base/schema.sql" \
    --command 'SET session_replication_role = replica' \
    --file "$PARKO_RESTORE/base/data.sql" \
    --dbname "$PARKO_TEST_DB_URL"
)
```

3. Vérifie que le bucket `parko-plates` existe, qu’il est **Private** et que ses limites correspondent à celles de la source. Compare les politiques de `storage.objects` avec les migrations de la version sauvegardée. Rétablis uniquement les définitions manquantes, puis configure Auth et le MFA du projet de test. Les clés API et les paramètres de projet se configurent dans le projet de test. [Règles du bucket PARKO](../supabase/migrations/202611230001_parking_register.sql#L99) · [Réglages après restauration](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore#schema-changes-to-auth-and-storage)
4. Utilise les clés du projet de test et applique la section **Restaurer les photos**. Ouvre ensuite une version de test de PARKO configurée avec l’URL et la clé publiable de ce projet et l’identifiant du parking restauré.

## Restaurer un lot local dans une instance jetable

1. Arrête temporairement l’instance locale source avec `npx supabase stop` depuis le dépôt. L’arrêt standard conserve son volume. Prépare une instance jetable avec le même niveau de migration et les mêmes comptes fictifs. Elle utilisera temporairement les mêmes ports. [Cycle de vie d’une instance locale](https://supabase.com/docs/guides/local-development/running-multiple-local-projects)

```bash
cd "$HOME/Parking app"
PARKO_CIBLE_LOCALE=$(mktemp -d "$HOME/parko-instance-test-XXXXXX")
PARKO_CIBLE_ID="parko-restore-$(date -u +%Y%m%d%H%M%S)"
mkdir -p "$PARKO_CIBLE_LOCALE/supabase"
cp -r supabase/config.toml supabase/migrations supabase/seed.sql "$PARKO_CIBLE_LOCALE/supabase/"
sed -i "s/^project_id = .*/project_id = \"$PARKO_CIBLE_ID\"/" "$PARKO_CIBLE_LOCALE/supabase/config.toml"
sed -i 's/PARKO — Test local/PARKO — Restauration jetable/' "$PARKO_CIBLE_LOCALE/supabase/seed.sql"
(cd "$PARKO_CIBLE_LOCALE" && npx supabase start)
```

2. Vérifie le démarrage de la cible. Dans la liste du dump, sélectionne uniquement les données des tables PARKO et la valeur de la séquence du journal d’audit. Laisse les comptes fictifs créés par le seed et les tables gérées par Supabase en place.

```bash
pg_restore --list "$PARKO_RESTORE/base/registre.dump" |
  awk '/ TABLE DATA public (parkings|parking_[^ ]+) / || / SEQUENCE SET public parking_audit_id_seq /' \
  > "$PARKO_RESTORE/registre.list"

cat "$PARKO_RESTORE/registre.list"
```

3. Depuis **SQL Editor du Studio local de la cible jetable**, exécute le bloc ci-dessous pour vider ses tables PARKO avant l’import. Cette opération efface les données de ces tables. Le bloc exige le marqueur de restauration créé par le seed de la cible.

```sql
begin;
do $$
begin
  if (select count(*) from public.parkings) <> 1 or not exists (
    select 1 from public.parkings
    where id = '10000000-0000-4000-8000-000000000001'
      and name = 'PARKO — Restauration jetable'
  ) then
    raise exception 'Le marqueur du parking de restauration est absent.';
  end if;
end;
$$;
truncate table
  public.parking_audit,
  public.parking_exit_reservations,
  public.parking_exit_documents,
  public.parking_visit_services,
  public.parking_visit_billing,
  public.parking_visits,
  public.parking_members,
  public.parkings;
commit;
```

4. Exécute la restauration en utilisant l’URL PostgreSQL affichée par `npx supabase status` dans le dossier de la cible jetable.

```bash
read -rsp 'Chaîne PostgreSQL de la cible JETABLE locale : ' PARKO_LOCAL_TEST_DB_URL
printf '\n'
pg_restore --data-only --disable-triggers --single-transaction \
  --use-list "$PARKO_RESTORE/registre.list" \
  --dbname "$PARKO_LOCAL_TEST_DB_URL" "$PARKO_RESTORE/base/registre.dump"
unset PARKO_LOCAL_TEST_DB_URL
```

5. Restaure les photos avec les coordonnées S3 locales de la cible. Lance `npm run test:local` depuis le dépôt et connecte-toi avec les comptes fictifs. Configure un facteur MFA si nécessaire. Après l’essai, arrête la cible depuis son dossier, puis redémarre l’instance d’origine depuis le dépôt. [Démarrage de PARKO avec Supabase local](../README.md#tester-sans-accéder-à-la-production)

## Restaurer les photos

Obtiens l’endpoint, la région et les clés S3 de la **cible de test**. Pour la cible locale, consulte `npx supabase status` dans son dossier. Utilise `parko-test` comme profil AWS CLI et vérifie que le bucket de destination est privé. Le bloc restaure chaque fichier avec son nom et son arborescence d’origine. `file` détecte le type MIME à partir du contenu car les photos PARKO peuvent avoir des noms sans extension. [Téléversement S3](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html) · [Connexion S3 au Supabase local](https://supabase.com/docs/guides/storage/s3/authentication#s3-access-keys)

```bash
aws configure --profile parko-test
aws configure set s3.addressing_style path --profile parko-test
read -rp 'Endpoint S3 de la cible de TEST : ' PARKO_TEST_S3_ENDPOINT
read -rp 'Référence du projet de test hébergé, ou local : ' PARKO_S3_TEST_REF

(
  set -euo pipefail
  if [[ "$PARKO_S3_TEST_REF" == local ]]; then
    [[ "${PARKO_TEST_S3_ENDPOINT%/}" == 'http://127.0.0.1:54321/storage/v1/s3' ||
       "${PARKO_TEST_S3_ENDPOINT%/}" == 'http://localhost:54321/storage/v1/s3' ]] || exit 1
  else
    [[ "$PARKO_S3_TEST_REF" =~ ^[a-z0-9]{20}$ &&
       "${PARKO_TEST_S3_ENDPOINT%/}" == "https://$PARKO_S3_TEST_REF.storage.supabase.co/storage/v1/s3" ]] || exit 1
  fi
  cd "$PARKO_RESTORE/photos"
  while IFS= read -r -d '' photo; do
    photo_type=$(file -b --mime-type "$photo")
    case "$photo_type" in
      image/jpeg|image/png|image/webp|image/heic|image/heif) ;;
      *) printf 'Type de photo à vérifier pour %s (%s)\n' "$photo" "$photo_type" >&2; exit 1 ;;
    esac
    aws --profile parko-test --endpoint-url "$PARKO_TEST_S3_ENDPOINT" \
      s3api put-object --bucket parko-plates --key "${photo#./}" \
      --body "$photo" --content-type "$photo_type" >/dev/null
  done < <(find . -type f -print0)
)
```

## Vérifier la restauration

Exécute cette requête sur la source pendant la fenêtre de sauvegarde puis dans le projet de test après restauration des photos. Compare les résultats et relève tout écart. Les chiffres du projet de test doivent correspondre à ceux du lot sauvegardé.

```sql
select
  count(*) filter (where exited_at is null) as vehicules_presents,
  count(*) filter (where exited_at is not null) as vehicules_sortis,
  (select count(*) from public.parking_exit_documents) as bons_de_sortie,
  (select count(*) from public.parking_visit_services) as prestations,
  (select count(*) from storage.objects where bucket_id = 'parko-plates') as photos,
  count(*) filter (
    where v.expects_photo and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'parko-plates'
        and o.name = v.parking_id::text || '/' || v.id::text
    )
  ) as visites_avec_photo_manquante
from public.parking_visits v;
```

- Connecte-toi avec un agent de test membre du parking. Ouvre un véhicule, sa photo et son bon de sortie. Vérifie que la photo s’affiche réellement et que le PDF du bon s’ouvre.
- Vérifie une prestation créée par l’agent. Pour une prestation enregistrée par un autre utilisateur ou un relevé de facturation, utilise un responsable de test si la migration 011 est appliquée.
- Essaie aussi avec un compte de test hors du parking. Le registre, les bons et les photos doivent lui être inaccessibles. Vérifie le MFA si l’environnement le requiert.
- Note l’horodatage du lot, les compteurs source et cible, la durée de restauration, les écarts et la décision de validation. Conserve ce compte rendu avec les archives. Retire les dossiers de restauration en clair après validation, selon la procédure de conservation de l’équipe.

## Programmer la sauvegarde quotidienne

1. Choisis une heure après la fermeture. Pour une première mise en service, fais un passage manuel complet et mesure le temps nécessaire pour produire et restaurer le lot.
2. Regroupe les commandes de sauvegarde et de chiffrement dans un script d’exploitation hors du dépôt. Remplace les invites par des paramètres provenant du coffre ou d’un fichier local protégé, lisible uniquement par le compte d’exploitation. Ajoute `set -euo pipefail`, évite les journaux de débogage qui dévoilent des secrets et déclenche une alerte si une archive ou la copie distante manque.
3. Planifie le script sur une machine qui reste disponible. Avec `cron` sur un système Linux où Docker tourne, un exemple de lancement quotidien à 22 h est `0 22 * * * /chemin/vers/sauvegarder-parko.sh`. Sous WSL, un déclenchement Windows doit aussi démarrer la distribution concernée et Docker doit être joignable. Fais un essai à l’heure planifiée.
4. Surveille la présence des deux archives du jour sur la destination. Fixe une durée de conservation selon le délai maximal de retour attendu. Rejoue régulièrement la restauration sur une cible jetable et avant toute migration qui modifie le schéma ou l’accès aux photos.
