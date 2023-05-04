//node lib/myfindvs.js

'use strict'

function debugInline(...argList) {

// this function will both print <argList> to stderr and return <argList>[0]

    process.stdout.write("\n\ndebugInline\n");
    process.stdout.write(String(argList) + "\n");
    process.stdout.write("\n\n");
    return argList[0];
}


const fs = require('fs')
const path = require('path').win32

function VisualStudioFinder () {
    this.errorLog = []
    this.validVersions = []
}

VisualStudioFinder.prototype = {

    // Logs a message at verbose level, but also saves it to be displayed later
    // at error level if an error occurs. This should help diagnose the problem.
    addLog: function addLog (message) {
        console.info(message)
        this.errorLog.push(message)
    },

    succeed: function succeed (info) {
        console.info(`using VS${info.versionYear} (${info.version}) found at:` +
                                    `\n"${info.path}"` +
                                    '\nrun with --verbose for detailed information')
        console.error(info)
    },

    // Invoke the PowerShell script to get information about Visual Studio 2017
    // or newer installations
    findVisualStudio2017OrNewer: function findVisualStudio2017OrNewer (cb) {
        var ps = path.join(process.env.SystemRoot, 'System32',
            'WindowsPowerShell', 'v1.0', 'powershell.exe')
        var csFile = path.join(__dirname, 'Find-VisualStudio.cs')
        var psArgs = [
            '-ExecutionPolicy',
            'Unrestricted',
            '-NoProfile',
            '-Command',
            '&{Add-Type -Path \'' + csFile + '\';' + '[VisualStudioConfiguration.Main]::PrintJson()}'
        ]

        console.info('Running', ps, psArgs)
        debugInline({
            ps,
            psArgs
        })
        var child = require('child_process').execFile(ps, psArgs, { encoding: 'utf8' },
            (err, stdout, stderr) => {
                this.parseData(err, stdout, stderr, cb)
            })
        child.stdin.end()
    },

    // Parse the output of the PowerShell script and look for an installation
    // of Visual Studio 2017 or newer to use
    parseData: function parseData (err, stdout, stderr, cb) {
        console.info('PS stderr = %j', stderr)

        const failPowershell = () => {
            this.addLog(
                'could not use PowerShell to find Visual Studio 2017 or newer, try re-running with \'--loglevel silly\' for more details')
            cb(null)
        }

        if (err) {
            console.info('PS err = %j', err && (err.stack || err))
            return failPowershell()
        }

        var vsInfo
        try {
            vsInfo = JSON.parse(stdout)
        } catch (e) {
            console.info('PS stdout = %j', stdout)
            console.info(e)
            return failPowershell()
        }

        if (!Array.isArray(vsInfo)) {
            console.info('PS stdout = %j', stdout)
            return failPowershell()
        }

        vsInfo = vsInfo.map((info) => {
            console.info(`processing installation: "${info.path}"`)
            info.path = path.resolve(info.path)
            var ret = this.getVersionInfo(info)
            ret.path = info.path
            ret.msBuild = this.getMSBuild(info, ret.versionYear)
            ret.toolset = this.getToolset(info, ret.versionYear)
            ret.sdk = this.getSDK(info)
            return ret
        })
        console.info('vsInfo:', vsInfo)

        // Remove future versions or errors parsing version number
        vsInfo = vsInfo.filter((info) => {
            if (info.versionYear) {
                return true
            }
            this.addLog(`unknown version "${info.version}" found at "${info.path}"`)
            return false
        })

        // Sort to place newer versions first
        vsInfo.sort((a, b) => b.versionYear - a.versionYear)

        for (var i = 0; i < vsInfo.length; ++i) {
            const info = vsInfo[i]
            this.addLog(`checking VS${info.versionYear} (${info.version}) found ` +
                                    `at:\n"${info.path}"`)

            if (info.msBuild) {
                this.addLog('- found "Visual Studio C++ core features"')
            } else {
                this.addLog('- "Visual Studio C++ core features" missing')
                continue
            }

            if (info.toolset) {
                this.addLog(`- found VC++ toolset: ${info.toolset}`)
            } else {
                this.addLog('- missing any VC++ toolset')
                continue
            }

            if (info.sdk) {
                this.addLog(`- found Windows SDK: ${info.sdk}`)
            } else {
                this.addLog('- missing any Windows SDK')
                continue
            }

            if (!this.checkConfigVersion(info.versionYear, info.path)) {
                continue
            }

            return cb(info)
        }

        this.addLog(
            'could not find a version of Visual Studio 2017 or newer to use')
        cb(null)
    },

    // Helper - process version information
    getVersionInfo: function getVersionInfo (info) {
        const match = /^(\d+)\.(\d+)\..*/.exec(info.version)
        if (!match) {
            console.info('- failed to parse version:', info.version)
            return {}
        }
        console.info('- version match = %j', match)
        var ret = {
            version: info.version,
            versionMajor: parseInt(match[1], 10),
            versionMinor: parseInt(match[2], 10)
        }
        if (ret.versionMajor === 15) {
            ret.versionYear = 2017
            return ret
        }
        if (ret.versionMajor === 16) {
            ret.versionYear = 2019
            return ret
        }
        if (ret.versionMajor === 17) {
            ret.versionYear = 2022
            return ret
        }
        console.info('- unsupported version:', ret.versionMajor)
        return {}
    },

    // Helper - process MSBuild information
    getMSBuild: function getMSBuild (info, versionYear) {
        const pkg = 'Microsoft.VisualStudio.VC.MSBuild.Base'
        const msbuildPath = path.join(info.path, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')
        if (info.packages.indexOf(pkg) !== -1) {
            console.info('- found VC.MSBuild.Base')
            if (versionYear === 2017) {
                return path.join(info.path, 'MSBuild', '15.0', 'Bin', 'MSBuild.exe')
            }
            if (versionYear === 2019) {
                return msbuildPath
            }
        }
        // visual studio 2022 don't has msbuild pkg
        if (fs.existsSync(msbuildPath)) {
            return msbuildPath
        }
        return null
    },

    // Helper - process toolset information
    getToolset: function getToolset (info, versionYear) {
        const pkg = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
        const express = 'Microsoft.VisualStudio.WDExpress'

        if (info.packages.indexOf(pkg) !== -1) {
            console.info('- found VC.Tools.x86.x64')
        } else if (info.packages.indexOf(express) !== -1) {
            console.info('- found Visual Studio Express (looking for toolset)')
        } else {
            return null
        }

        if (versionYear === 2017) {
            return 'v141'
        } else if (versionYear === 2019) {
            return 'v142'
        } else if (versionYear === 2022) {
            return 'v143'
        }
        console.info('- invalid versionYear:', versionYear)
        return null
    },

    // Helper - process Windows SDK information
    getSDK: function getSDK (info) {
        const win8SDK = 'Microsoft.VisualStudio.Component.Windows81SDK'
        const win10SDKPrefix = 'Microsoft.VisualStudio.Component.Windows10SDK.'

        var Win10SDKVer = 0
        info.packages.forEach((pkg) => {
            if (!pkg.startsWith(win10SDKPrefix)) {
                return
            }
            const parts = pkg.split('.')
            if (parts.length > 5 && parts[5] !== 'Desktop') {
                console.info('- ignoring non-Desktop Win10SDK:', pkg)
                return
            }
            const foundSdkVer = parseInt(parts[4], 10)
            if (isNaN(foundSdkVer)) {
                // Microsoft.VisualStudio.Component.Windows10SDK.IpOverUsb
                console.info('- failed to parse Win10SDK number:', pkg)
                return
            }
            console.info('- found Win10SDK:', foundSdkVer)
            Win10SDKVer = Math.max(Win10SDKVer, foundSdkVer)
        })

        if (Win10SDKVer !== 0) {
            return `10.0.${Win10SDKVer}.0`
        } else if (info.packages.indexOf(win8SDK) !== -1) {
            console.info('- found Win8SDK')
            return '8.1'
        }
        return null
    },

    // After finding a usable version of Visual Studio:
    // - add it to validVersions to be displayed at the end if a specific
    //   version was requested and not found;
    // - check if this is the version that was requested.
    // - check if this matches the Visual Studio Command Prompt
    checkConfigVersion: function checkConfigVersion (versionYear, vsPath) {
        this.validVersions.push(versionYear)
        this.validVersions.push(vsPath)

        if (this.envVcInstallDir &&
                path.relative(this.envVcInstallDir, vsPath) !== '') {
            this.addLog('- does not match this Visual Studio Command Prompt')
            return false
        }

        return true
    }
}

    function findVisualStudio (that) {
        if (process.env.VCINSTALLDIR) {
            that.envVcInstallDir =
                path.resolve(process.env.VCINSTALLDIR, '..')
            that.addLog('running in VS Command Prompt, installation path is:\n' +
                `"${that.envVcInstallDir}"\n- will only use this version`)
        } else {
            that.addLog('VCINSTALLDIR not set, not running in VS Command Prompt')
        }

        that.findVisualStudio2017OrNewer((info) => {
            if (info) {
                return that.succeed(info)
            }
        })
    }


findVisualStudio(
new VisualStudioFinder()
)
