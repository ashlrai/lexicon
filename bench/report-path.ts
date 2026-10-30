/** Use portable separators for relative paths stored in benchmark reports. */
export function reportPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}
