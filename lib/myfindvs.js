/*
node lib/myfindvs.js
shRunWithCoverage node lib/myfindvs.js
*/

'use strict'

// init debugInline
let debugInline = (function () {
    let __consoleError = function () {
        return;
    };
    function debug(...argv) {

// This function will print <argv> to stderr and then return <argv>[0].

        __consoleError("\n\ndebugInline");
        __consoleError(...argv);
        __consoleError("\n");
        return argv[0];
    }
    debug(); // Coverage-hack.
    __consoleError = console.error; //jslint-ignore-line
    return debug;
}());


const fs = require('fs')
const modulePath = require('path').win32

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

    // Invoke the PowerShell script to get information about Visual Studio 2017
    // or newer installations
    findVisualStudio2017OrNewer: function findVisualStudio2017OrNewer (cb) {
        var ps = modulePath.join(
            process.env.SystemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        )
        var psArgs = [
            "-ExecutionPolicy",
            "Unrestricted",
            "-NoProfile",
            "-Command",
            "&{Add-Type -Path \"" + modulePath.join(__dirname, "Find-VisualStudio.cs") + "\";" + "[VisualStudioConfiguration.Main]::PrintJson()}"
        ]

        console.info("Running", ps, psArgs)
        debugInline({
            ps,
            psArgs
        })
        var that = this;
        var child = require("child_process").execFile(ps, psArgs, { encoding: "utf8" },
            //!! (err, stdout, stderr) => {
                //!! this.parseData(err, stdout, stderr, cb)
            //!! }

    // Parse the output of the PowerShell script and look for an installation
    // of Visual Studio 2017 or newer to use
    //!! parseData:
    function parseData (err, stdout, stderr) {
        console.info("PS stderr = %j", stderr)

        const failPowershell = () => {
            that.addLog(
                "could not use PowerShell to find Visual Studio 2017 or newer, try re-running with \"--loglevel silly\" for more details")
            cb(null)
        }

        if (err) {
            console.info("PS err = %j", err && (err.stack || err))
            return failPowershell()
        }

        var vsInfo
        try {
            vsInfo = JSON.parse(stdout)
        } catch (e) {
            console.info("PS stdout = %j", stdout)
            console.info(e)
            return failPowershell()
        }

        if (!Array.isArray(vsInfo)) {
            console.info("PS stdout = %j", stdout)
            return failPowershell()
        }

        vsInfo = vsInfo.map((info) => {
            console.info(`processing installation: "${info.path}"`)
            info.path = modulePath.resolve(info.path)
            var ret = that.getVersionInfo(info)
            ret.path = info.path
            ret.msBuild = that.getMSBuild(info, ret.versionYear)
            ret.toolset = that.getToolset(info, ret.versionYear)
            ret.sdk = that.getSDK(info)
            return ret
        })
        console.info("vsInfo:", vsInfo)

        // Remove future versions or errors parsing version number
        vsInfo = vsInfo.filter((info) => {
            if (info.versionYear) {
                return true
            }
            that.addLog(`unknown version "${info.version}" found at "${info.path}"`)
            return false
        })

        // Sort to place newer versions first
        vsInfo.sort((a, b) => b.versionYear - a.versionYear)

        for (var i = 0; i < vsInfo.length; ++i) {
            const info = vsInfo[i]
            that.addLog(`checking VS${info.versionYear} (${info.version}) found ` +
                                    `at:\n"${info.path}"`)

            if (info.msBuild) {
                that.addLog('- found "Visual Studio C++ core features"')
            } else {
                that.addLog('- "Visual Studio C++ core features" missing')
                continue
            }

            if (info.toolset) {
                that.addLog(`- found VC++ toolset: ${info.toolset}`)
            } else {
                that.addLog('- missing any VC++ toolset')
                continue
            }

            if (info.sdk) {
                that.addLog(`- found Windows SDK: ${info.sdk}`)
            } else {
                that.addLog('- missing any Windows SDK')
                continue
            }

            if (!that.checkConfigVersion(info.versionYear, info.path)) {
                continue
            }

            return cb(info)
        }

        that.addLog(
            'could not find a version of Visual Studio 2017 or newer to use')
        cb(null)
    }
        );
        child.stdin.end()
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
        const msbuildPath = modulePath.join(info.path, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe')
        if (info.packages.indexOf(pkg) !== -1) {
            console.info('- found VC.MSBuild.Base')
            if (versionYear === 2017) {
                return modulePath.join(info.path, 'MSBuild', '15.0', 'Bin', 'MSBuild.exe')
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
                modulePath.relative(this.envVcInstallDir, vsPath) !== '') {
            this.addLog('- does not match this Visual Studio Command Prompt')
            return false
        }

        return true
    }
}

    function findVisualStudio (that) {
        if (process.env.VCINSTALLDIR) {
            that.envVcInstallDir =
                modulePath.resolve(process.env.VCINSTALLDIR, '..')
            that.addLog('running in VS Command Prompt, installation path is:\n' +
                `"${that.envVcInstallDir}"\n- will only use this version`)
        } else {
            that.addLog('VCINSTALLDIR not set, not running in VS Command Prompt')
        }

        that.findVisualStudio2017OrNewer((info) => {
            if (info) {
        console.info(`using VS${info.versionYear} (${info.version}) found at:` +
                                    `\n"${info.path}"` +
                                    "\nrun with --verbose for detailed information")
        console.error(info)
            }
        })
    }


findVisualStudio(
new VisualStudioFinder()
)
