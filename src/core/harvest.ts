/**
 * Repo harvester: scans a project directory for proper nouns worth adding to
 * the lexicon (package names, PascalCase identifiers, git authors, README
 * brands, the project directory name) and ranks them by occurrence count.
 *
 * Synchronous fs is used deliberately: the scan is bounded (5000 files, 512KB
 * each) and a single pass is simpler to reason about than an async walk.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { suggestAliases } from './suggest.js';
import type { HarvestCandidate, HarvestOptions, TermCategory, TermSource } from './types.js';

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_EVIDENCE = 5;

const ALWAYS_IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'vendor',
  'target',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

const READ_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.rb', '.swift', '.kt',
  '.cs', '.md', '.json', '.toml', '.mod',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.rb', '.swift', '.kt', '.cs',
]);

const GENERIC_ROOT_NAMES = new Set([
  'src', 'app', 'apps', 'project', 'projects', 'repo', 'repos', 'code', 'dev', 'work', 'workspace',
  'tmp', 'temp', 'test', 'tests', 'home', 'desktop', 'documents', 'downloads', 'main', 'master',
  'lib', 'packages', 'package', 'www', 'web', 'site', 'server', 'client', 'api', 'new', 'old',
]);

/** Identifiers that are too generic to be worth teaching an STT engine. */
const GENERIC_IDENTIFIERS = new Set([
  'String', 'Number', 'Boolean', 'Error', 'Object', 'Array', 'Promise', 'Component', 'Props',
  'State', 'Request', 'Response', 'Map', 'Set', 'Date', 'JSON', 'TypeError', 'RegExp', 'Buffer',
  'Function', 'Symbol', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude',
  'Extract', 'ReturnType', 'NonNullable', 'Parameters', 'InstanceType', 'Awaited', 'Uppercase',
  'Lowercase', 'Capitalize', 'Uncapitalize', 'ThisType', 'ArrayBuffer', 'Uint8Array', 'Int32Array',
  'Float64Array', 'DataView', 'WeakMap', 'WeakSet', 'WeakRef', 'BigInt', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'PromiseLike',
  'ArrayLike', 'Iterable', 'Iterator', 'AsyncIterable', 'AsyncIterator', 'Generator',
  'AsyncGenerator', 'IterableIterator', 'AsyncIterableIterator', 'ReadonlyArray', 'ReadonlyMap',
  'ReadonlySet', 'PropertyKey', 'PropertyDescriptor', 'ClassDecorator', 'MethodDecorator',
  'ParameterDecorator', 'PropertyDecorator', 'TemplateStringsArray', 'ImportMeta', 'ErrorOptions',
  'AbortController', 'AbortSignal', 'EventTarget', 'EventEmitter', 'EventListener', 'TextEncoder',
  'TextDecoder', 'URLSearchParams', 'FormData', 'ReadableStream', 'WritableStream',
  'TransformStream', 'MessageChannel', 'MessagePort', 'WebSocket', 'Worker', 'Blob', 'File',
  'FileReader', 'Headers', 'Storage', 'Location', 'History', 'Navigator', 'Document', 'Window',
  'Element', 'Node', 'NodeList', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'TouchEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'DragEvent', 'WheelEvent',
  'ProcessEnv', 'NodeJS', 'Console', 'Process', 'Timeout', 'Immediate', 'Dirent', 'Stats',
  'PathLike', 'Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough', 'ChildProcess',
  'Server', 'Socket', 'IncomingMessage', 'ServerResponse', 'ClientRequest', 'Agent',
  'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException',
  'NullPointerException', 'IndexOutOfBoundsException', 'UnsupportedOperationException',
  'BaseException', 'ValueError', 'KeyError', 'TypeVar', 'Optional', 'Union', 'Callable',
  'Sequence', 'Mapping', 'Dict', 'List', 'Tuple', 'Any', 'None', 'True', 'False',
  'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'TreeMap', 'StringBuilder', 'Integer',
  'Long', 'Double', 'Float', 'Short', 'Byte', 'Character', 'Void', 'Result', 'Option', 'Vec',
  'Box', 'Rc', 'Arc', 'Mutex', 'RwLock', 'Cell', 'RefCell', 'HashMapEntry', 'BTreeMap',
  'BTreeSet', 'VecDeque', 'PhantomData', 'Default', 'Clone', 'Copy', 'Debug', 'Display',
  'Send', 'Sync', 'Sized', 'Drop', 'Iterator', 'IntoIterator', 'FromIterator', 'ToString',
  'From', 'Into', 'TryFrom', 'TryInto', 'AsRef', 'AsMut', 'Deref', 'DerefMut', 'PartialEq',
  'PartialOrd', 'Ord', 'Eq', 'Hash', 'Self', 'Some', 'Ok', 'Err', 'Context', 'Provider',
  'Consumer', 'Fragment', 'Suspense', 'StrictMode', 'Profiler', 'Ref', 'RefObject',
  'MutableRefObject', 'ReactNode', 'ReactElement', 'FC', 'PropsWithChildren', 'CSSProperties',
  'SyntheticEvent', 'ChangeEvent', 'FormEvent', 'ClickEvent', 'Config', 'Options', 'Params',
  'Result', 'Data', 'Item', 'Items', 'Value', 'Values', 'Key', 'Keys', 'Type', 'Types', 'Info',
  'Meta', 'Metadata', 'Base', 'Abstract', 'Interface', 'Impl', 'Util', 'Utils', 'Helper',
  'Helpers', 'Service', 'Services', 'Controller', 'Model', 'View', 'Handler', 'Manager',
  'Factory', 'Builder', 'Client', 'Resolver', 'Middleware', 'Router', 'Route', 'Module',
  'Plugin', 'Test', 'Tests', 'Mock', 'Spec', 'Fixture', 'Setup', 'Teardown', 'Main', 'Index',
  'App', 'Application', 'Program', 'Entry', 'Point', 'Object', 'Instance', 'Callback',
  'Listener', 'Subscriber', 'Publisher', 'Observer', 'Observable', 'Subject', 'Stream',
  'Reader', 'Writer', 'Parser', 'Formatter', 'Serializer', 'Deserializer', 'Validator',
  'Schema', 'Entity', 'Repository', 'Store', 'Cache', 'Queue', 'Stack', 'Tree', 'Graph',
  'Edge', 'Vertex', 'Path', 'Uri', 'Url', 'Http', 'Https', 'Html', 'Css', 'Xml', 'Yaml', 'Csv',
  'Sql', 'Json', 'Text', 'Binary', 'Image', 'Video', 'Audio', 'Color', 'Size', 'Position',
  'Rect', 'Point', 'Vector', 'Matrix', 'Angle', 'Time', 'Duration', 'Timer', 'Clock',
  'Logger', 'Log', 'Level', 'Debug', 'Info', 'Warn', 'Fatal', 'Trace', 'Status', 'Code',
  'Message', 'Payload', 'Body', 'Header', 'Footer', 'Content', 'Section', 'Block', 'Line',
  'Column', 'Row', 'Cell', 'Table', 'Grid', 'Layout', 'Panel', 'Card', 'Modal', 'Dialog',
  'Button', 'Input', 'Form', 'Field', 'Label', 'Select', 'Checkbox', 'Radio', 'Slider',
  'Toggle', 'Switch', 'Menu', 'Nav', 'Sidebar', 'Toolbar', 'Tooltip', 'Popover', 'Dropdown',
  'Tabs', 'Tab', 'Accordion', 'Alert', 'Toast', 'Badge', 'Avatar', 'Icon', 'Spinner',
  'Loader', 'Skeleton', 'Progress', 'Chart', 'Legend', 'Axis', 'Series', 'Tick', 'Marker',
  'Wrapper', 'Container', 'Outer', 'Inner', 'Root', 'Child', 'Parent', 'Sibling', 'Leaf',
  'Token', 'Tokens', 'Session', 'User', 'Users', 'Account', 'Profile', 'Settings', 'Preferences',
  'Permission', 'Permissions', 'Role', 'Roles', 'Group', 'Groups', 'Team', 'Teams', 'Member',
  'Members', 'Owner', 'Admin', 'Guest', 'Anonymous', 'Public', 'Private', 'Protected',
  'Internal', 'External', 'Local', 'Remote', 'Global', 'Scope', 'Namespace', 'Package',
  'Version', 'Release', 'Build', 'Deploy', 'Env', 'Environment', 'Development', 'Production',
  'Staging', 'Testing', 'Enum', 'Struct', 'Class', 'Trait', 'Protocol', 'Extension',
  'Delegate', 'DataSource', 'ViewController', 'ViewModel', 'UIView', 'UIViewController',
  'UILabel', 'UIButton', 'UIImage', 'UIColor', 'NSObject', 'NSString', 'NSArray',
  'NSDictionary', 'CGFloat', 'CGRect', 'CGPoint', 'CGSize', 'IBOutlet', 'IBAction',
  'TODO', 'FIXME', 'NOTE', 'HACK', 'XXX',
]);

/**
 * Prefix families that are nearly always framework/platform names rather than
 * something the user invented (React*, Http*, Json*, HTML*).
 */
const GENERIC_PREFIXES = ['React', 'Http', 'Json', 'HTML', 'Html', 'SVG', 'Svg', 'DOM', 'CSS', 'URL', 'XML', 'Xml'];

/**
 * Capitalized English / doc words that appear in READMEs and must not be
 * mistaken for brands.
 */
export const HARVEST_STOPLIST: ReadonlySet<string> = new Set([
  // articles, pronouns, determiners, conjunctions
  'The', 'This', 'That', 'These', 'Those', 'There', 'Here', 'They', 'Them', 'Their', 'Then',
  'Than', 'Thus', 'What', 'When', 'Where', 'Which', 'While', 'Whom', 'Whose', 'With', 'Without',
  'Within', 'Your', 'Yours', 'Ours', 'Some', 'Such', 'Same', 'Each', 'Every', 'Either', 'Neither',
  'Both', 'Also', 'Only', 'Just', 'Even', 'Ever', 'Never', 'Always', 'Often', 'Once', 'Again',
  'Still', 'Already', 'Almost', 'Although', 'Because', 'Before', 'After', 'Since', 'Until',
  'Unless', 'Whether', 'Though', 'However', 'Therefore', 'Otherwise', 'Instead', 'Please',
  'Thanks', 'Thank', 'Welcome', 'Hello', 'About', 'Above', 'Below', 'Under', 'Over', 'Into',
  'Onto', 'From', 'Through', 'Between', 'Among', 'Around', 'Across', 'Along', 'Against',
  'Toward', 'Towards', 'Upon', 'Down', 'Back', 'Away', 'Very', 'Much', 'More', 'Most', 'Many',
  'Less', 'Least', 'Other', 'Another', 'Others', 'Else', 'Next', 'Last', 'First', 'Second',
  'Third', 'Final', 'Finally', 'Then', 'Now', 'Today', 'Soon', 'Later', 'Earlier', 'Recently',
  'Currently', 'Yes', 'None', 'Nothing', 'Something', 'Anything', 'Everything', 'Someone',
  'Anyone', 'Everyone', 'Nobody', 'Does', 'Do', 'Did', 'Done', 'Doing', 'Have', 'Has', 'Had',
  'Having', 'Will', 'Would', 'Should', 'Could', 'Must', 'Might', 'May', 'Can', 'Cannot', 'Shall',
  'Make', 'Makes', 'Made', 'Making', 'Take', 'Takes', 'Took', 'Taking', 'Give', 'Gives', 'Gave',
  'Given', 'Need', 'Needs', 'Needed', 'Want', 'Wants', 'Wanted', 'Know', 'Known', 'Knows', 'See',
  'Sees', 'Seen', 'Look', 'Looks', 'Looking', 'Find', 'Finds', 'Found', 'Keep', 'Keeps', 'Kept',
  'Let', 'Lets', 'Like', 'Likes', 'Think', 'Thinks', 'Thought', 'Feel', 'Feels', 'Felt', 'Come',
  'Comes', 'Came', 'Coming', 'Goes', 'Going', 'Gone', 'Went', 'Say', 'Says', 'Said', 'Tell',
  'Tells', 'Told', 'Ask', 'Asks', 'Asked', 'Try', 'Tries', 'Tried', 'Call', 'Calls', 'Called',
  'Work', 'Works', 'Worked', 'Working', 'Turn', 'Turns', 'Show', 'Shows', 'Shown', 'Read',
  'Reads', 'Write', 'Writes', 'Written', 'Open', 'Opens', 'Close', 'Closes', 'Closed',
  'Start', 'Starts', 'Started', 'Starting', 'Stop', 'Stops', 'Stopped', 'Getting', 'Get',
  'Gets', 'Got', 'Put', 'Puts', 'Set', 'Sets', 'Setting', 'Settings', 'Add', 'Adds', 'Added',
  'Adding', 'Remove', 'Removes', 'Removed', 'Removing', 'Delete', 'Deletes', 'Deleted',
  'Update', 'Updates', 'Updated', 'Updating', 'Create', 'Creates', 'Created', 'Creating',
  'Build', 'Builds', 'Building', 'Built', 'Run', 'Runs', 'Running', 'Ran', 'Test', 'Tests',
  'Testing', 'Tested', 'Check', 'Checks', 'Checked', 'Checking', 'Change', 'Changes', 'Changed',
  'Changelog', 'Configure', 'Configuration', 'Config', 'Configs', 'Setup', 'Install',
  'Installation', 'Installing', 'Installed', 'Uninstall', 'Usage', 'Use', 'Uses', 'Used',
  'Using', 'User', 'Users', 'Example', 'Examples', 'Note', 'Notes', 'Todo', 'Todos', 'Readme',
  'License', 'Licence', 'Licensed', 'Copyright', 'Contributing', 'Contributors', 'Contribute',
  'Contribution', 'Contributions', 'Author', 'Authors', 'Maintainer', 'Maintainers', 'Credits',
  'Acknowledgements', 'Acknowledgments', 'Thanks', 'Overview', 'Introduction', 'Intro',
  'Background', 'Motivation', 'Features', 'Feature', 'Requirements', 'Requirement',
  'Prerequisites', 'Prerequisite', 'Dependencies', 'Dependency', 'Quick', 'Quickstart',
  'Guide', 'Guides', 'Tutorial', 'Tutorials', 'Documentation', 'Docs', 'Doc', 'Reference',
  'References', 'Roadmap', 'Status', 'Support', 'Supported', 'Supports', 'Options', 'Option',
  'Arguments', 'Argument', 'Parameters', 'Parameter', 'Returns', 'Return', 'Result', 'Results',
  'Output', 'Outputs', 'Input', 'Inputs', 'Command', 'Commands', 'Flag', 'Flags', 'Default',
  'Defaults', 'Advanced', 'Basic', 'Basics', 'Simple', 'Custom', 'Manual', 'Automatic',
  'Optional', 'Required', 'Recommended', 'Deprecated', 'Experimental', 'Stable', 'Beta',
  'Alpha', 'Preview', 'Release', 'Releases', 'Version', 'Versions', 'Versioning', 'Latest',
  'Current', 'Previous', 'Upgrade', 'Upgrading', 'Migration', 'Migrating', 'Migrate',
  'Breaking', 'Fixed', 'Fixes', 'Fix', 'Bug', 'Bugs', 'Issue', 'Issues', 'Pull', 'Request',
  'Requests', 'Merge', 'Commit', 'Commits', 'Branch', 'Branches', 'Fork', 'Clone', 'Push',
  'Repository', 'Repo', 'Project', 'Projects', 'Package', 'Packages', 'Module', 'Modules',
  'Library', 'Libraries', 'Framework', 'Frameworks', 'Tool', 'Tools', 'Toolkit', 'Plugin',
  'Plugins', 'Extension', 'Extensions', 'Script', 'Scripts', 'File', 'Files', 'Folder',
  'Folders', 'Directory', 'Directories', 'Path', 'Paths', 'Source', 'Sources', 'Code',
  'Server', 'Servers', 'Client', 'Clients', 'Service', 'Services', 'Development', 'Develop',
  'Developer', 'Developers', 'Production', 'Environment', 'Environments', 'Local', 'Remote',
  'Global', 'Public', 'Private', 'Security', 'Secure', 'Performance', 'Fast', 'Faster',
  'Simple', 'Simply', 'Easy', 'Easily', 'Powerful', 'Lightweight', 'Modern', 'Minimal',
  'Free', 'Open', 'Community', 'Team', 'Company', 'Home', 'Page', 'Pages', 'Website', 'Site',
  'Link', 'Links', 'Image', 'Images', 'Screenshot', 'Screenshots', 'Demo', 'Demos', 'Live',
  'Table', 'Contents', 'Content', 'Section', 'Sections', 'Chapter', 'Part', 'Step', 'Steps',
  'Warning', 'Caution', 'Important', 'Tip', 'Tips', 'Trick', 'Tricks', 'Hint', 'Hints',
  'Info', 'Information', 'Details', 'Detail', 'Summary', 'Description', 'Purpose', 'Goal',
  'Goals', 'Why', 'How', 'Who', 'Yes', 'No', 'Not', 'And', 'But', 'For', 'Nor', 'Yet', 'So',
  'If', 'Or', 'As', 'At', 'By', 'In', 'Of', 'On', 'To', 'Up', 'Is', 'It', 'Its', 'Be', 'Been',
  'Being', 'Are', 'Was', 'Were', 'Am', 'An', 'A', 'I', 'We', 'You', 'He', 'She', 'Me', 'Him',
  'Her', 'Us', 'My', 'Our', 'His', 'Hers', 'Mine', 'All', 'Any', 'Few', 'Several', 'One',
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Zero', 'Hundred',
  'Thousand', 'Million', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  'Sunday', 'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'English', 'True', 'False', 'Null', 'Undefined', 'Nil',
  'Error', 'Errors', 'Exception', 'Exceptions', 'Debug', 'Debugging', 'Logging', 'Logs',
  'Log', 'Verbose', 'Silent', 'Quiet', 'Help', 'Helper', 'Helpers', 'Utility', 'Utilities',
  'Data', 'Database', 'Databases', 'Model', 'Models', 'Schema', 'Schemas', 'Type', 'Types',
  'Interface', 'Interfaces', 'Class', 'Classes', 'Function', 'Functions', 'Method', 'Methods',
  'Property', 'Properties', 'Object', 'Objects', 'Array', 'Arrays', 'String', 'Strings',
  'Number', 'Numbers', 'Boolean', 'Booleans', 'Value', 'Values', 'Key', 'Keys', 'Name',
  'Names', 'Id', 'Ids', 'Index', 'Indices', 'List', 'Lists', 'Map', 'Maps', 'Item', 'Items',
  'Element', 'Elements', 'Node', 'Nodes', 'Tree', 'Graph', 'Event', 'Events', 'Handler',
  'Handlers', 'Hook', 'Hooks', 'Context', 'Store', 'Action', 'Actions', 'Reducer', 'State',
  'Component', 'Components', 'Render', 'Rendering', 'Style', 'Styles', 'Theme', 'Themes',
  'Layout', 'Design', 'Icon', 'Icons', 'Font', 'Fonts', 'Color', 'Colors', 'Dark', 'Light',
  'Mode', 'Modes', 'Window', 'Windows', 'Mac', 'Linux', 'Unix', 'Browser', 'Browsers',
  'Mobile', 'Desktop', 'Web', 'Native', 'Cloud', 'Edge', 'Network', 'Networks', 'Internet',
  'Online', 'Offline', 'Sync', 'Async', 'Await', 'Promise', 'Promises', 'Stream', 'Streams',
  'Buffer', 'Buffers', 'Memory', 'Disk', 'Cache', 'Caching', 'Speed', 'Size', 'Limit',
  'Limits', 'Rate', 'Rates', 'Count', 'Counts', 'Total', 'Totals', 'Average', 'Maximum',
  'Minimum', 'Max', 'Min', 'Range', 'Ranges', 'Level', 'Levels', 'Priority', 'Order',
  'Sort', 'Sorted', 'Filter', 'Filtered', 'Search', 'Searching', 'Match', 'Matches', 'Matching',
  'Replace', 'Replaces', 'Replacement', 'Replacements', 'Pattern', 'Patterns', 'Regex',
  'Format', 'Formats', 'Formatting', 'Parse', 'Parser', 'Parsing', 'Export', 'Exports',
  'Import', 'Imports', 'Load', 'Loads', 'Loading', 'Save', 'Saves', 'Saving', 'Print',
  'Prints', 'Display', 'Displays', 'Enable', 'Enabled', 'Disable', 'Disabled', 'Allow',
  'Allowed', 'Deny', 'Denied', 'Accept', 'Accepted', 'Reject', 'Rejected', 'Confirm',
  'Cancel', 'Continue', 'Skip', 'Retry', 'Refresh', 'Reload', 'Reset', 'Restore', 'Clear',
  'Clean', 'Cleanup', 'Voice', 'Speech', 'Text', 'Audio', 'Video', 'Word', 'Words',
  'Sentence', 'Sentences', 'Line', 'Lines', 'Paragraph', 'Language', 'Languages',
]);

interface Bucket {
  canonical: string;
  category: TermCategory;
  source: TermSource;
  evidence: string[];
  count: number;
  /** Bypass minCount (project name, git authors, dot-TLD brands). */
  alwaysInclude: boolean;
}

interface WalkResult {
  files: string[];
  truncated: boolean;
}

export async function harvestRepo(root: string, opts: HarvestOptions = {}): Promise<HarvestCandidate[]> {
  const absRoot = path.resolve(root);
  const stat = safeStat(absRoot);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`harvestRepo: not a directory: ${absRoot}`);
  }

  const ignore = new Set<string>([...ALWAYS_IGNORED_DIRS, ...(opts.ignore ?? [])]);
  const wantGit = opts.git !== false;
  const wantPackages = opts.packages !== false;
  const wantIdentifiers = opts.identifiers !== false;
  const minCount = opts.minCount ?? 2;
  const limit = opts.limit ?? 50;

  const buckets = new Map<string, Bucket>();
  const bump = (
    canonical: string,
    category: TermCategory,
    source: TermSource,
    evidence: string,
    count = 1,
    alwaysInclude = false,
  ): void => {
    const name = canonical.trim();
    if (!name) return;
    const key = name.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { canonical: name, category, source, evidence: [], count: 0, alwaysInclude: false };
      buckets.set(key, bucket);
    } else if (categoryRank(category) < categoryRank(bucket.category)) {
      // A more specific classification (brand/product/person) beats 'identifier'.
      bucket.category = category;
      bucket.source = source;
    }
    bucket.count += count;
    bucket.alwaysInclude ||= alwaysInclude;
    if (bucket.evidence.length < MAX_EVIDENCE && !bucket.evidence.includes(evidence)) {
      bucket.evidence.push(evidence);
    }
  };

  // 4. project directory name
  const rootName = path.basename(absRoot);
  if (rootName && !GENERIC_ROOT_NAMES.has(rootName.toLowerCase()) && /^[A-Za-z]/.test(rootName)) {
    bump(rootName, 'product', 'harvest:repo', 'directory name', 1, true);
  }

  // 3. git authors
  if (wantGit) {
    for (const author of gitAuthors(absRoot)) {
      bump(author, 'person', 'harvest:git', 'git log', 1, true);
    }
  }

  const { files } = walk(absRoot, ignore);

  for (const file of files) {
    const rel = path.relative(absRoot, file) || path.basename(file);
    const base = path.basename(file);
    const ext = path.extname(file).toLowerCase();

    // 1. manifests
    if (wantPackages) {
      if (base === 'package.json') {
        harvestPackageJson(file, rel, bump);
        continue;
      }
      if (base === 'pyproject.toml') {
        harvestPyproject(file, rel, bump);
        continue;
      }
      if (base === 'Cargo.toml') {
        harvestCargo(file, rel, bump);
        continue;
      }
      if (base === 'go.mod') {
        harvestGoMod(file, rel, bump);
        continue;
      }
    }

    if (ext === '.json' || ext === '.toml' || ext === '.mod') continue;

    const text = readText(file);
    if (text === undefined) continue;

    // 5b. dot-TLD brands anywhere in md / source
    if (ext === '.md' || SOURCE_EXTENSIONS.has(ext)) {
      for (const [brand, n] of countMatches(text, DOT_TLD_RE)) {
        bump(brand, 'brand', 'harvest:repo', rel, n, true);
      }
    }

    // 5a. README proper nouns
    if (ext === '.md' && /^readme/i.test(base)) {
      for (const [word, n] of readmeProperNouns(text)) {
        bump(word, 'brand', 'harvest:repo', rel, n);
      }
      continue;
    }

    // 2. PascalCase identifiers
    if (wantIdentifiers && SOURCE_EXTENSIONS.has(ext)) {
      for (const [ident, n] of pascalCaseIdentifiers(text)) {
        bump(ident, 'identifier', 'harvest:repo', rel, n);
      }
    }
  }

  const candidates: HarvestCandidate[] = [];
  for (const bucket of buckets.values()) {
    if (!bucket.alwaysInclude && bucket.count < minCount) continue;
    candidates.push({
      canonical: bucket.canonical,
      category: bucket.category,
      source: bucket.source,
      evidence: bucket.evidence,
      count: bucket.count,
      suggestedAliases: safeSuggest(bucket.canonical),
    });
  }

  candidates.sort((a, b) => b.count - a.count || a.canonical.localeCompare(b.canonical));
  return candidates.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

function walk(root: string, ignore: Set<string>): WalkResult {
  const files: string[] = [];
  const stack: string[] = [root];
  let truncated = false;
  while (stack.length > 0 && !truncated) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Deterministic order so counts/evidence are stable across runs.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!READ_EXTENSIONS.has(ext)) continue;
      files.push(full);
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }
  return { files, truncated };
}

function readText(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function safeStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

type Bump = (
  canonical: string,
  category: TermCategory,
  source: TermSource,
  evidence: string,
  count?: number,
  alwaysInclude?: boolean,
) => void;

/** Dependency names too generic to be worth a lexicon entry. */
const GENERIC_DEP_WORDS = new Set([
  'sdk', 'core', 'cli', 'api', 'app', 'lib', 'util', 'utils', 'types', 'test', 'tests',
  'react', 'node', 'client', 'server', 'common', 'shared', 'base', 'config', 'tools', 'plugin',
  'plugins', 'helpers', 'helper', 'main', 'index', 'data', 'json', 'yaml', 'xml', 'csv', 'http',
  'https', 'path', 'file', 'files', 'time', 'date', 'debug', 'log', 'logger', 'logging', 'error',
  'errors', 'event', 'events', 'stream', 'streams', 'buffer', 'process', 'crypto', 'string',
  'strings', 'number', 'numbers', 'object', 'array', 'promise', 'async', 'sync', 'request',
  'response', 'fetch', 'router', 'route', 'routes', 'model', 'models', 'view', 'views',
  'controller', 'controllers', 'schema', 'validate', 'validation', 'validator', 'parser',
  'parse', 'format', 'formatter', 'build', 'bundle', 'compile', 'compiler', 'loader', 'loaders',
  'style', 'styles', 'theme', 'themes', 'icon', 'icons', 'image', 'images', 'font', 'fonts',
  'color', 'colors', 'form', 'forms', 'table', 'tables', 'list', 'lists', 'tree', 'graph',
  'chart', 'charts', 'store', 'cache', 'queue', 'worker', 'workers', 'task', 'tasks', 'job',
  'jobs', 'cron', 'timer', 'clock', 'uuid', 'hash', 'random', 'math', 'stats', 'metrics',
  'monitor', 'health', 'auth', 'session', 'user', 'users', 'admin', 'mail', 'email', 'sms',
  'push', 'notify', 'notification', 'notifications', 'search', 'filter', 'sort', 'match',
  'replace', 'regex', 'glob', 'watch', 'watcher', 'reload', 'dev', 'prod', 'env', 'dotenv',
  'typescript', 'javascript', 'python', 'java', 'ruby', 'rust', 'swift', 'kotlin', 'golang',
  'lint', 'linter', 'prettier', 'format', 'semver', 'chalk', 'commander', 'yargs', 'minimist',
  'express', 'lodash', 'underscore', 'moment', 'dayjs', 'axios', 'jest', 'mocha', 'chai',
  'sinon', 'vitest', 'eslint', 'tslint', 'babel', 'webpack', 'rollup', 'vite', 'esbuild',
  'terser', 'uglify', 'postcss', 'sass', 'less', 'stylus', 'tailwind', 'bootstrap',
  'requests', 'pytest', 'numpy', 'pandas', 'flask', 'django', 'serde', 'tokio', 'anyhow',
  'thiserror', 'clap', 'regex', 'rand', 'chrono', 'reqwest', 'hyper', 'tower', 'tracing',
]);

function harvestDependencyName(dep: string, evidence: string, bump: Bump): void {
  // "@modelcontextprotocol/sdk" -> bare name "sdk" (skipped, generic); scope kept in evidence.
  let bare = dep;
  let scope: string | undefined;
  const m = /^@([^/]+)\/(.+)$/.exec(dep);
  if (m) {
    scope = m[1];
    bare = m[2];
  }
  const ev = scope ? `${evidence} (@${scope}/${bare})` : evidence;
  for (const part of [bare, scope]) {
    if (!part) continue;
    if (part.length < 4) continue;
    if (GENERIC_DEP_WORDS.has(part.toLowerCase())) continue;
    if (HARVEST_STOPLIST.has(capitalize(part))) continue;
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(part)) continue;
    bump(part, 'identifier', 'harvest:package', ev, 1);
  }
}

function harvestPackageJson(file: string, rel: string, bump: Bump): void {
  const text = readText(file);
  if (text === undefined) return;
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(pkg)) return;
  if (typeof pkg.name === 'string' && pkg.name.trim()) {
    const m = /^@([^/]+)\/(.+)$/.exec(pkg.name);
    const bare = m ? m[2] : pkg.name;
    // A project literally named "server", "app" or "cli" is not a proper noun; do not
    // seed the lexicon with it (its suggested aliases would misfire on ordinary prose).
    const generic =
      bare.length < 4 || GENERIC_DEP_WORDS.has(bare.toLowerCase()) || HARVEST_STOPLIST.has(capitalize(bare));
    if (!generic) bump(bare, 'product', 'harvest:package', `${rel}#name`, 1, true);
    if (m && m[1].length >= 4 && !GENERIC_DEP_WORDS.has(m[1].toLowerCase())) {
      bump(m[1], 'brand', 'harvest:package', `${rel}#name (@${m[1]}/${bare})`, 1, true);
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!isRecord(deps)) continue;
    for (const dep of Object.keys(deps)) harvestDependencyName(dep, `${rel}#${field}`, bump);
  }
}

function harvestPyproject(file: string, rel: string, bump: Bump): void {
  const text = readText(file);
  if (text === undefined) return;
  const sections = tomlSections(text);
  const project = sections.get('project') ?? sections.get('tool.poetry') ?? '';
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(project);
  if (name) bump(name[1], 'product', 'harvest:package', `${rel}#project.name`, 1, true);
  const depsBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(project);
  if (depsBlock) {
    for (const m of depsBlock[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) {
      harvestDependencyName(m[1], `${rel}#project.dependencies`, bump);
    }
  }
  const poetryDeps = sections.get('tool.poetry.dependencies');
  if (poetryDeps) {
    for (const m of poetryDeps.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)) {
      if (m[1].toLowerCase() === 'python') continue;
      harvestDependencyName(m[1], `${rel}#tool.poetry.dependencies`, bump);
    }
  }
}

function harvestCargo(file: string, rel: string, bump: Bump): void {
  const text = readText(file);
  if (text === undefined) return;
  const sections = tomlSections(text);
  const pkg = sections.get('package') ?? '';
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pkg);
  if (name) bump(name[1], 'product', 'harvest:package', `${rel}#package.name`, 1, true);
  for (const key of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    const block = sections.get(key);
    if (!block) continue;
    for (const m of block.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
      harvestDependencyName(m[1], `${rel}#${key}`, bump);
    }
  }
}

function harvestGoMod(file: string, rel: string, bump: Bump): void {
  const text = readText(file);
  if (text === undefined) return;
  const mod = /^module\s+(\S+)/m.exec(text);
  if (mod) {
    const last = mod[1].split('/').pop() ?? mod[1];
    // Strip a major-version suffix like "/v2".
    const name = /^v\d+$/.test(last) ? (mod[1].split('/').slice(-2, -1)[0] ?? last) : last;
    bump(name, 'product', 'harvest:package', `${rel}#module`, 1, true);
  }
  const requireBlocks = [...text.matchAll(/require\s*\(([\s\S]*?)\)/g)].map((m) => m[1]);
  const singles = [...text.matchAll(/^require\s+(\S+)\s+\S+/gm)].map((m) => m[1]);
  const modulePaths = [
    ...requireBlocks.flatMap((b) => [...b.matchAll(/^\s*(\S+)\s+\S+/gm)].map((m) => m[1])),
    ...singles,
  ];
  for (const mp of modulePaths) {
    const segs = mp.split('/').filter((s) => !/^v\d+$/.test(s));
    const last = segs[segs.length - 1];
    if (last) harvestDependencyName(last, `${rel}#require`, bump);
  }
}

/** Minimal TOML sectioning: header -> raw body text. Enough for name/deps extraction. */
function tomlSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (current) out.set(current, (out.get(current) ?? '') + buf.join('\n') + '\n');
    buf = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      flush();
      current = header[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Source identifiers
// ---------------------------------------------------------------------------

/** PascalCase with at least two humps: Upper+lower..., Upper+... (e.g. LexiconStore, OpenClaw). */
const PASCAL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b/g;

/** Something like "Ashlr.AI", "Foo.io", "Next.js" — a name with a dot-TLD tail. */
const DOT_TLD_RE = /\b[A-Z][A-Za-z0-9]{1,}\.(?:AI|ai|io|IO|com|dev|app|sh|co|js|ts|net|org|xyz|so|gg|fm|tv|me)\b(?![\w/]|\.\w)/g;

function pascalCaseIdentifiers(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(PASCAL_RE)) {
    const ident = m[0];
    if (ident.length < 5) continue;
    if (humps(ident) < 2) continue;
    if (isGenericIdentifier(ident)) continue;
    out.set(ident, (out.get(ident) ?? 0) + 1);
  }
  return out;
}

function humps(ident: string): number {
  return (ident.match(/[A-Z]/g) ?? []).length;
}

function isGenericIdentifier(ident: string): boolean {
  if (GENERIC_IDENTIFIERS.has(ident)) return true;
  for (const prefix of GENERIC_PREFIXES) {
    if (ident.startsWith(prefix) && ident.length > prefix.length && /[A-Z]/.test(ident[prefix.length])) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

function readmeProperNouns(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const stripped = stripMarkdownNoise(text);
  const sentences = stripped.split(/(?<=[.!?:])\s+|\n+/);
  for (const sentence of sentences) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      // i starts at 1: the first token of a sentence is capitalized regardless.
      const word = tokens[i].replace(/^[^A-Za-z]+|[^A-Za-z0-9]+$/g, '');
      if (word.length < 4) continue;
      if (!/^[A-Z][a-z]+(?:[A-Z][a-zA-Z]*)*$/.test(word)) continue;
      if (HARVEST_STOPLIST.has(word)) continue;
      if (GENERIC_IDENTIFIERS.has(word)) continue;
      out.set(word, (out.get(word) ?? 0) + 1);
    }
  }
  return out;
}

/** Remove code fences, inline code, URLs, badges and heading markers before scanning prose. */
function stripMarkdownNoise(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#+\s*/gm, '');
}

function countMatches(text: string, re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(re)) {
    out.set(m[0], (out.get(m[0]) ?? 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function gitAuthors(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'log', '--format=%an', '-n', '500'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const seen = new Set<string>();
    const authors: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const name = line.trim();
      if (!name) continue;
      // Skip bot-ish and email-only authors.
      if (/\[bot\]$/i.test(name) || /@/.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      authors.push(name);
    }
    return authors;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function categoryRank(category: TermCategory): number {
  switch (category) {
    case 'brand':
      return 0;
    case 'product':
      return 1;
    case 'person':
      return 2;
    case 'acronym':
      return 3;
    case 'place':
      return 4;
    case 'identifier':
      return 5;
    default:
      return 6;
  }
}

function safeSuggest(canonical: string): string[] {
  try {
    const result = suggestAliases(canonical);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
