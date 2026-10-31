# Starts a process through WMI (Win32_Process.Create) so it is NOT a child of the caller's Job object.
# Used by volunteer-run.py when the Job forbids CREATE_BREAKAWAY_FROM_JOB. No secrets pass through here:
# the command line and cwd come from env VR_CMDLINE / VR_CWD. Prints the new process id; exit 1 on failure.
$ErrorActionPreference = "Stop"
try {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $args = @{ CommandLine = $env:VR_CMDLINE; ProcessStartupInformation = $startup }
    if ($env:VR_CWD) { $args["CurrentDirectory"] = $env:VR_CWD }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $args
    if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned " + $r.ReturnValue); exit 1 }
    Write-Output $r.ProcessId
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
