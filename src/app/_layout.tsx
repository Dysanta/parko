import { Slot } from 'expo-router';
import { Head } from 'expo-router/head';
import { Platform } from 'react-native';

export default function RootLayout() {
  return (
    <>
      {Platform.OS === 'web' && (
        <Head>
          <link rel="icon" type="image/png" sizes="192x192" href="/apple-touch-icon.png" />
          <link rel="apple-touch-icon" sizes="192x192" href="/apple-touch-icon.png" />
        </Head>
      )}
      <Slot />
    </>
  );
}
