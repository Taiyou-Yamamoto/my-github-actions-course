import fs from 'node:fs/promises';
import path from 'node:path';
import licenseOverrides from './config';

const TARGETS = ['packages/react', 'packages/vue', 'packages/vanilla'];

interface LockedPackage extends LicenseInfo {
    // すでに追記済みかどうかを持つフラグを追加しておく
    proceed?: {
        [key: string]: {
            dependencies: boolean;
            devDependencies: boolean;
        };
    };
    // ライセンスの本文を保持しておく
    licenseText?: string;

    name?: string;
    version?: string;
    license?: string;
    workspaces?: string[];
    dependencies?: {
        [key: string]: string;
    };
    devDependencies?: {
        [key: string]: string;
    };
    optionalDependencies?: {
        [key: string]: string;
    };
}

interface LockFile {
    name: string;
    lockfileVersion: 3;
    packages: {
        [key: string]: LockedPackage;
    };
}

interface Package extends LockedPackage {
    repository?:
        | string
        | {
              type: 'git';
              url: string;
          };
}

const lockFile = JSON.parse(await fs.readFile('package-lock.json', 'utf-8')) as LockFile;
if (lockFile.lockfileVersion !== 3) {
    throw new Error('Unsupported package-lock version');
}
let packages = new Map(Object.entries(structuredClone(lockFile.packages)));

interface PackageInfo {
    /**
     * package-lock.jsonに記載されているパッケージ情報
     */
    package: LockedPackage;
    /**
     * パッケージ名
     */
    name: string;
    /**
     * パッケージの場所
     */
    path: string[];
}

/**
 * @param name パッケージ名
 * @param path 現在のパス ここから上方向にnode_modulesを探す
 */
const findPackage = (name: string, path: string[] = []): PackageInfo | null => {
    if (name.startsWith('@d7lab/bx-components')) {
        const localName = name.replace('@d7lab/bx-components-', '');
        const pkg = packages.get('packages/' + localName);
        if (pkg) {
            return { package: pkg, name: localName, path: ['packages'] };
        } else {
            return null;
        }
    } else {
        path.push('node_modules');
        do {
            const pkg = packages.get(`${path.join('/')}${path.length > 0 ? '/' : ''}${name}`);
            if (pkg) {
                return { package: pkg, name, path };
            }
        } while (path.pop());

        const pkgInRoot = packages.get(`node_modules/${name}`);
        if (pkgInRoot) {
            return { package: pkgInRoot, name, path: ['node_modules'] };
        }

        return null;
    }
};

export interface LicenseInfo {
    license?: string;
    licenseText?: string;
}

const licenseCache: Record<string, LicenseInfo> = {};

/**
 * ライセンス情報が不明なパッケージ名のリスト
 */
const noLicenseTextPackageNames = new Set<string>();

/**
 * パッケージのライセンス情報を取得する
 */
const getLicenseInfo = async (pkg: PackageInfo | null): Promise<LicenseInfo | null> => {
    if (!pkg) {
        return null;
    }

    // 内部パッケージは無視
    if (pkg.path[0] === 'packages') {
        return null;
    }

    // 個別に上書き指定があるとき、まずそれを適用
    pkg.package.license = licenseOverrides[pkg.name]?.license ?? pkg.package.license;
    pkg.package.licenseText = licenseOverrides[pkg.name]?.licenseText ?? pkg.package.licenseText;

    if (pkg.package.license && pkg.package.licenseText) {
        return {
            license: pkg.package.license,
            licenseText: pkg.package.licenseText,
        };
    }

    const findLicenseFile = async (directory: string) => {
        const dir = await fs.readdir(directory);
        const licenseFiles = dir.filter((file) => /LICEN[CS]E.*/.test(file.toUpperCase()));
        const licenseFile = licenseFiles.find((file) => file === 'LICENSE') ?? licenseFiles[0];
        if (licenseFile) {
            try {
                const licenseText = await fs.readFile(path.resolve(directory, licenseFile));
                pkg.package.licenseText = licenseText.toString();

                return {
                    license: pkg.package.license,
                    licenseText: pkg.package.licenseText,
                };
            } catch (e) {
                console.warn(`Failed to read license file ${licenseFile} in ${directory}`, e);
                // ファイルがないときなど
            }
        }
    };

    const packageLocation = path.resolve(...pkg.path, pkg.name);

    const local = await findLicenseFile(packageLocation);

    if (local) {
        return local;
    }

    const packageJson = JSON.parse(await fs.readFile(path.resolve(packageLocation, 'package.json'), 'utf-8')) as Package;
    const repositoryUrl = typeof packageJson.repository === 'object' ? packageJson.repository.url : packageJson.repository;
    const match = repositoryUrl?.match(/([^\/:]+)\/([^\/]+)$/);
    if (match) {
        const [, owner, repo] = match;
        const repoName = repo.replace(/\.git$/, '');
        const repository = `${owner}/${repoName}`;

        if (licenseCache[repository]) {
            return licenseCache[repository];
        }

        // まずraw.githubusercontent.comから取得できないか試す
        console.log(`fetching license from GitHub repository: ${repository}`);
        const rawUrl = `https://raw.githubusercontent.com/${repository}/HEAD/LICENSE`;
        try {
            const response = await fetch(rawUrl);
            if (response.ok) {
                const licenseText = await response.text();
                if (licenseText) {
                    return (licenseCache[repository] = {
                        license: packageJson.license,
                        licenseText,
                    });
                }
            }
        } catch (e) {
            console.warn(`Failed to fetch license from ${rawUrl}`, e);
        }
    }
    console.warn(
        `\n============================================================\nライセンス情報が不明です: ${packageJson.name}\n${pkg.path.join('/')}/${pkg.name}/package.json\n============================================================\n`
    );
    noLicenseTextPackageNames.add(pkg.name);

    return null;
};

interface LicenseResult extends PackageInfo {
    name: string;
    version?: string;
    licenseName?: string;
    licenseText?: string;
}

/**
 * @param workspaceName 起点となるワークスペース名 (すでに追加したかどうかを保持するため、これをキーとして保持する)
 * @param currentPackage 現在のパッケージ情報
 * @param depth 再帰の深さ (ログ表示用)
 * @param inDevDeps 現在の対象がdevDependenciesとして依存に含まれているか、いないか
 * @returns 依存パッケージのライセンス情報のリスト
 */
const walk = async (
    workspaceName: string,
    currentPackage: PackageInfo | null,
    depth = 0,
    inDevDeps = false
): Promise<{
    dependencies: LicenseResult[];
    devDependencies: LicenseResult[];
}> => {
    if (!currentPackage) {
        return {
            dependencies: [],
            devDependencies: [],
        };
    }

    const depsList: LicenseResult[] = [];
    const devDepsList: LicenseResult[] = [];

    const scan = async (name: string, inDevDeps: boolean) => {
        const depPackage = findPackage(name, currentPackage.path);
        if (
            depPackage &&
            (inDevDeps
                ? depPackage.package.proceed?.[workspaceName]?.dependencies !== true
                : depPackage.package.proceed?.[workspaceName]?.devDependencies !== true)
        ) {
            depPackage.package.proceed ??= {};
            depPackage.package.proceed[workspaceName] ??= { dependencies: false, devDependencies: false };
            depPackage.package.proceed[workspaceName][inDevDeps ? 'dependencies' : 'devDependencies'] = true;

            const licenseInfo = await getLicenseInfo(depPackage);

            const result: LicenseResult = {
                ...depPackage,
                name: name,
                version: depPackage.package.version,
                licenseName: licenseInfo?.license,
                licenseText: licenseInfo?.licenseText,
            };

            if (inDevDeps) {
                devDepsList.push(result);
            } else {
                depsList.push(result);
            }

            try {
                console.log(' '.repeat(depth * 2 - 1), name, ' '.repeat(100 - depth * 2 - name.length), licenseInfo?.license ?? 'ライセンス情報なし');
            } catch (e) {}

            const { dependencies, devDependencies } = await walk(workspaceName, depPackage, depth + 1, inDevDeps);
            depsList.push(...dependencies);
            devDepsList.push(...devDependencies);
            // OptDepsList.push(...optionalDependencies);
        }
    };

    for (const pkgName of Object.keys(currentPackage.package.dependencies ?? {})) {
        await scan(pkgName, inDevDeps);
    }

    for (const depName of Object.keys(currentPackage.package.devDependencies ?? {})) {
        await scan(depName, true);
    }

    const normalizedDeps = depsList.filter((d) => !d.name.startsWith('@d7lab/'));
    const normalizedDevDeps = devDepsList.filter((d) => !d.name.startsWith('@d7lab/'));

    return { dependencies: normalizedDeps, devDependencies: normalizedDevDeps };
};

const formatLicense = (licenseResults: LicenseResult[]) =>
    licenseResults
        .map((result) => {
            const text = ['---------------------------------------------------------\n'];

            text.push(`${result.name}@${result.version} - ${result.licenseName ?? 'UNKNOWN'}\n`);

            if (result.licenseText) {
                text.push('\n');
                text.push(result.licenseText);
                if (!result.licenseText.endsWith('\n\n')) text.push('\n');
            } else {
                text.push('\nNo license text provided.\n\n');
                console.warn(
                    `ライセンス本文を取得できないパッケージが存在しました: ${result.name}@${result.version}`,
                    `${result.path.join('/')}/${result.name}/package.json`
                );
            }

            text.push('---------------------------------------------------------\n');
            return text.join('');
        })
        .filter(Boolean)
        .join('');

const formatJSON = (licenseResults: LicenseResult[]) =>
    JSON.stringify(
        licenseResults.map((result) => {
            return {
                name: result.name,
                licenseName: result.licenseName ?? 'UNKNOWN',
                licenseText: result.licenseText ?? 'No license text provided.',
            };
        })
    );

const parsePlayerLicenseText = (licenseText: string): LicenseResult[] => {
    return licenseText.split('\n\n\n').map((text) => {
        const lines = text.split('\n');
        const name = lines[0].trim();
        const license = lines[1].trim();
        const licenseText = lines.slice(2).join('\n').trim();
        return {
            name: name,
            version: '',
            licenseName: license,
            licenseText: licenseText,
            package: {},
            path: [],
        };
    });
};

const main = async () => {
    for (const workspace of TARGETS) {
        const { dependencies, devDependencies } = await walk(workspace, findPackage(workspace));

        const finalDependencies: LicenseResult[] = [...dependencies];

        if (workspace === 'packages/react') {
            const playerLicense = await fs.readFile(path.resolve('./packages/react/src/player/HSKPlayer/lib/playersdk/playersdk.LICENSE.txt'));
            const playerLicenseResults = parsePlayerLicenseText(playerLicense.toString('utf-8'));
            finalDependencies.push(...playerLicenseResults);
        }

        await fs.mkdir(path.resolve('./.licenses', workspace.split('/')[1]), { recursive: true });
        await fs.writeFile(path.resolve('./.licenses', workspace.split('/')[1], 'LICENSES.txt'), formatLicense(finalDependencies));
        await fs.writeFile(path.resolve('./.licenses', workspace.split('/')[1], 'LICENSES.json'), formatJSON(finalDependencies));
        await fs.writeFile(path.resolve('./.licenses', workspace.split('/')[1], 'LICENSES_DEV.txt'), formatLicense(devDependencies));
        await fs.writeFile(path.resolve('./.licenses', workspace.split('/')[1], 'LICENSES_OPT_DEV.txt'), formatLicense(optionalDependencies));
        console.log('\n\n');
    }

    if (noLicenseTextPackageNames.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100)); // GitHub Actions上でログ順序が壊れるので少し待つ
        console.error(
            `\n============================================================\nライセンス情報が不明なパッケージがあります: \n- ${Array.from(noLicenseTextPackageNames).join('\n- ')}\n============================================================\n`
        );
        process.exit(1);
    }
};

await main();
