// File cards remain the persisted kind; only supported originals get a reader.
export function documentFormat(filename = '', mime = '') {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (extension === 'epub' || mime === 'application/epub+zip') return 'epub';
  return null;
}
