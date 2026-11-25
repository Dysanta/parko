import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { encode } from 'js-base64';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Choice } from './BillingPanels';
import { COLORS } from './theme';

const svgDataPrefix = 'data:image/svg+xml;utf-8,';

export function ParkingMfa({ auth, onVerified }: { auth: SupabaseClient['auth']; onVerified: () => void }) {
  const [factorId, setFactorId] = useState<string>();
  const [enrollment, setEnrollment] = useState<{ secret: string; qrUri: string | null }>();
  const [showSecret, setShowSecret] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const pending = useRef<string[]>([]);
  const working = useRef(false);

  useEffect(() => {
    let active = true;
    void auth.mfa.listFactors().then(({ data, error: issue }) => {
      if (!active) return;
      if (issue) throw issue;
      pending.current = data.all.filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified')
        .map((factor) => factor.id);
      setFactorId(data.totp[0]?.id);
      setLoaded(true);
    }).catch((issue: unknown) => {
      if (active) setError(issue instanceof Error ? issue.message : 'Impossible de vérifier le second facteur.');
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [auth]);

  async function run(action: () => Promise<void>) {
    if (working.current || !loaded) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Impossible de vérifier le second facteur.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function enroll() {
    void run(async () => {
      for (const id of pending.current) {
        const { error: issue } = await auth.mfa.unenroll({ factorId: id });
        if (issue) throw issue;
        pending.current = pending.current.filter((pendingId) => pendingId !== id);
      }
      const { data, error: issue } = await auth.mfa.enroll({ factorType: 'totp', issuer: 'PARKO' });
      if (issue) throw issue;
      const { qr_code: qrCode, secret } = data.totp;
      // The native image loader expects a Base64 data URI.
      const qrUri = qrCode?.startsWith(svgDataPrefix)
        ? `data:image/svg+xml;base64,${encode(qrCode.slice(svgDataPrefix.length))}`
        : null;
      setFactorId(data.id);
      setEnrollment({ secret, qrUri });
    });
  }

  function verify() {
    if (!factorId || !/^\d{6}$/.test(code)) return;
    void run(async () => {
      const { error: issue } = await auth.mfa.challengeAndVerify({ factorId, code });
      if (issue) throw issue;
      setEnrollment(undefined);
      onVerified();
    });
  }

  return (
    <View style={styles.form}>
      <Text accessibilityRole="header" style={styles.title}>Double authentification</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {factorId ? (
        <>
          {enrollment ? (
            <>
              {enrollment.qrUri && (
                <>
                  <Text>Scanne ce QR code avec ton application d’authentification.</Text>
                  <Image source={{ uri: enrollment.qrUri }} accessibilityLabel="QR code de configuration du MFA"
                    accessible cachePolicy="none" contentFit="contain" style={styles.qrCode}
                    onError={() => setEnrollment((current) => current && { ...current, qrUri: null })} />
                  <Choice label={showSecret ? 'Masquer la clé manuelle' : 'Afficher la clé manuelle'}
                    onPress={() => setShowSecret(!showSecret)} />
                </>
              )}
              {(showSecret || !enrollment.qrUri) && (
                <>
                  <Text>Pour configurer le compte manuellement, ajoute cette clé dans ton application d’authentification et choisis un code basé sur le temps.</Text>
                  <Text selectable style={styles.secret}>{enrollment.secret}</Text>
                </>
              )}
              <Text>Saisis le code à six chiffres affiché dans ton application.</Text>
            </>
          ) : <Text>Saisis le code à six chiffres de ton application d’authentification.</Text>}
          <TextInput accessibilityLabel="Code de vérification" inputMode="numeric" maxLength={6}
            value={code} onChangeText={setCode} onSubmitEditing={verify} editable={!busy} style={styles.input} />
          <Choice label="Vérifier le code" onPress={verify} disabled={busy || !/^\d{6}$/.test(code)} selected />
        </>
      ) : <Choice label="Configurer l’application d’authentification" disabled={busy || !loaded} onPress={enroll} selected />}
      <Text>Si tu perds ton appareil, contacte un administrateur du projet pour vérifier ton identité et rétablir l’accès.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  title: { color: COLORS.ink, fontSize: 20, fontWeight: '800' },
  error: { color: COLORS.error },
  qrCode: { width: 208, height: 208, alignSelf: 'center', backgroundColor: COLORS.white },
  secret: { backgroundColor: COLORS.orangeTint, color: COLORS.ink, padding: 10 },
  input: { borderColor: COLORS.border, borderWidth: 1, color: COLORS.ink, padding: 10, borderRadius: 8 },
});
