// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Controlled lists of the DataCite Metadata Schema 4.7, transcribed from
// https://schema.datacite.org/meta/kernel-4.7/include/ (the files
// datacite-resourceType-v4.xsd, datacite-relatedIdentifierType-v4.xsd and
// datacite-relationType-v4.xsd). The `research-items` and `research-related`
// values use DataCite's exact, case-sensitive spelling; the manifest is
// checked against these lists so a typo fails before anything is signed.

export const RESOURCE_TYPE_GENERAL = new Set([
  'Audiovisual', 'Award', 'Book', 'BookChapter', 'Collection', 'ComputationalNotebook', 'ConferencePaper',
  'ConferenceProceeding', 'DataPaper', 'Dataset', 'Dissertation', 'Event', 'Image', 'Instrument',
  'InteractiveResource', 'Journal', 'JournalArticle', 'Model', 'OutputManagementPlan', 'PeerReview',
  'PhysicalObject', 'Poster', 'Preprint', 'Presentation', 'Project', 'Report', 'Service', 'Software', 'Sound',
  'Standard', 'StudyRegistration', 'Text', 'Workflow', 'Other'
]);

export const RELATED_IDENTIFIER_TYPE = new Set([
  'ARK', 'arXiv', 'bibcode', 'CSTR', 'DOI', 'EAN13', 'EISSN', 'Handle', 'IGSN', 'ISBN', 'ISSN', 'ISTC', 'LISSN',
  'LSID', 'PMID', 'PURL', 'RAiD', 'RRID', 'SWHID', 'UPC', 'URL', 'URN', 'w3id'
]);

export const RELATION_TYPE = new Set([
  'IsCitedBy', 'Cites', 'IsSupplementTo', 'IsSupplementedBy', 'IsContinuedBy', 'Continues', 'IsNewVersionOf',
  'IsPreviousVersionOf', 'IsPartOf', 'HasPart', 'IsPublishedIn', 'IsReferencedBy', 'References', 'IsDocumentedBy',
  'Documents', 'IsCompiledBy', 'Compiles', 'IsVariantFormOf', 'IsOriginalFormOf', 'IsIdenticalTo', 'HasMetadata',
  'IsMetadataFor', 'Reviews', 'IsReviewedBy', 'IsDerivedFrom', 'IsSourceOf', 'Describes', 'IsDescribedBy',
  'HasVersion', 'IsVersionOf', 'Requires', 'IsRequiredBy', 'Obsoletes', 'IsObsoletedBy', 'Collects',
  'IsCollectedBy', 'HasTranslation', 'IsTranslationOf', 'Other'
]);
