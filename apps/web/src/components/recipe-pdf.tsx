// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Document, Page, StyleSheet, Text, View, pdf } from '@react-pdf/renderer';
import { ensureFontRegistered, Mark } from '@/lib/pdf-common';
import type { SharedRecipe } from '@/lib/recipe-share';

/*
 * A recipe sent to somebody, as a document of A4 pages: the application's
 * mark, the title, the ingredients with their amounts, the steps, and under
 * them where the recipe is from and a model's part in it. It is made on the
 * page from what the page holds; nothing is asked of a server but the
 * typeface and the mark.
 */
const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 44,
    fontFamily: 'Inter',
    fontSize: 10.5,
    lineHeight: 1.4,
    color: '#000',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 6,
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#000',
  },
  brandText: { fontSize: 11, fontWeight: 700 },
  title: { fontSize: 20, fontWeight: 700, lineHeight: 1.2, marginBottom: 16 },
  section: { marginBottom: 16 },
  heading: {
    fontSize: 8.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingBottom: 2,
    marginBottom: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#999',
  },
  ingredient: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#ddd',
  },
  name: { flex: 1 },
  note: { fontSize: 8.5, color: '#555' },
  amount: { textAlign: 'right', color: '#222' },
  step: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  number: { width: 18, fontWeight: 700, textAlign: 'right' },
  stepText: { flex: 1 },
  notes: { fontSize: 8, color: '#555', marginTop: 2 },
  pageNumber: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 7.5,
    color: '#888',
  },
});

function RecipeDocument({ recipe, appName }: { recipe: SharedRecipe; appName: string }) {
  return (
    <Document title={recipe.title}>
      <Page size="A4" style={styles.page}>
        <View style={styles.brand}>
          <Mark />
          <Text style={styles.brandText}>{appName}</Text>
        </View>
        <Text style={styles.title}>{recipe.title}</Text>
        <View style={styles.section}>
          <Text style={styles.heading} minPresenceAhead={40}>
            {recipe.ingredientsHeading}
          </Text>
          {recipe.ingredients.map((line, index) => (
            <View key={index} style={styles.ingredient} wrap={false}>
              <View style={styles.name}>
                <Text>{line.name}</Text>
                {line.note && <Text style={styles.note}>{line.note}</Text>}
              </View>
              <Text style={styles.amount}>{line.amount}</Text>
            </View>
          ))}
        </View>
        <View style={styles.section}>
          <Text style={styles.heading} minPresenceAhead={40}>
            {recipe.stepsHeading}
          </Text>
          {recipe.steps.map((step, index) => (
            <View key={index} style={styles.step} wrap={false}>
              <Text style={styles.number}>{index + 1}.</Text>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
        {recipe.notes.map((note, index) => (
          <Text key={index} style={styles.notes}>
            {note}
          </Text>
        ))}
        {/* The number of a page, where the recipe takes more than one. */}
        <Text
          style={styles.pageNumber}
          fixed
          render={({ pageNumber, totalPages }) =>
            totalPages > 1 ? `${pageNumber} / ${totalPages}` : ''
          }
        />
      </Page>
    </Document>
  );
}

/** The recipe as a PDF file, under the application's name. */
export async function recipePdf(recipe: SharedRecipe, appName: string): Promise<Blob> {
  ensureFontRegistered();
  return pdf(<RecipeDocument recipe={recipe} appName={appName} />).toBlob();
}
