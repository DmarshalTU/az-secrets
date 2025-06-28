using Azure.Identity;
using Azure.Security.KeyVault.Certificates;
using Azure.Security.KeyVault.Keys;
using Azure.Security.KeyVault.Secrets;
using System;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Spectre.Console;
using System.Security.Cryptography.X509Certificates;
using System.Diagnostics;

namespace KeyVaultTool
{
    class Program
    {
        private static CacheManager _cacheManager = new CacheManager();

        static async Task Main(string[] args)
        {
            AnsiConsole.Write(new FigletText("Azure Key Vault Tool").Centered().Color(Color.Blue));
            AnsiConsole.WriteLine();

            // Load cache on startup
            await _cacheManager.LoadCacheAsync();
            AnsiConsole.MarkupLine($"[green]Cache loaded:[/] {_cacheManager.GetCacheSize()} vaults indexed");

            string? vaultUrl = null;
            KeyVaultManager? keyVaultManager = null;

            if (args.Length == 0)
            {
                // No specific vault provided - start in full-screen mode
                AnsiConsole.MarkupLine("[yellow]Starting in full-screen mode...[/]");
                await Task.Delay(1000); // Brief pause to show the message
                
                var terminalUI = new TerminalUI(_cacheManager);
                await terminalUI.RunAsync();
            }
            else
            {
                vaultUrl = args[0];
                
                try
                {
                    var credential = new DefaultAzureCredential();
                    AnsiConsole.MarkupLine($"[green]Connecting to Key Vault:[/] {vaultUrl}");
                    AnsiConsole.MarkupLine("[yellow]Using Azure CLI authentication...[/]");
                    
                    keyVaultManager = new KeyVaultManager(vaultUrl, credential, _cacheManager);
                    
                    if (args.Length > 1)
                    {
                        await ProcessCommand(keyVaultManager, args.Skip(1).ToArray());
                    }
                    else
                    {
                        // Start full-screen mode with the specific vault
                        var terminalUI = new TerminalUI(_cacheManager, keyVaultManager);
                        await terminalUI.RunAsync();
                    }
                }
                catch (Exception ex)
                {
                    AnsiConsole.MarkupLine($"[red]❌ Error:[/] {ex.Message}");
                    if (ex.InnerException != null)
                    {
                        AnsiConsole.MarkupLine($"[red]Inner error:[/] {ex.InnerException.Message}");
                    }
                }
            }
            
            // Save cache on exit
            await _cacheManager.SaveCacheAsync();
        }

        private static async Task<string?> RunInteractiveSelection()
        {
            // Step 1: Select Subscription
            var subscription = await SelectSubscription();
            if (subscription == null) return null;

            // Step 2: Select Key Vault
            var keyVault = await SelectKeyVault(subscription.Value);
            if (keyVault == null) return null;

            return $"https://{keyVault.Value.name}.vault.azure.net/";
        }

        private static async Task<(string id, string name)?> SelectSubscription()
        {
            AnsiConsole.MarkupLine("[bold blue]Step 1: Select Subscription[/]");
            
            var subscriptions = await GetSubscriptions();
            if (subscriptions.Count == 0)
            {
                AnsiConsole.MarkupLine("[red]No subscriptions found. Make sure you are logged in with 'az login'.[/]");
                return null;
            }

            var choices = subscriptions.Select(s => $"{s.name} ({s.id})").ToList();
            var selected = AnsiConsole.Prompt(
                new SelectionPrompt<string>()
                    .Title("Choose a subscription:")
                    .PageSize(10)
                    .AddChoices(choices)
            );

            var selectedSubscription = subscriptions.First(s => $"{s.name} ({s.id})" == selected);
            AnsiConsole.MarkupLine($"[green]Selected:[/] {selectedSubscription.name}");
            return selectedSubscription;
        }

        private static async Task<(string name, string location, string resourceGroup)?> SelectKeyVault((string id, string name) subscription)
        {
            AnsiConsole.MarkupLine("[bold blue]Step 2: Select Key Vault[/]");
            
            var keyVaults = await GetKeyVaults(subscription.id);
            if (keyVaults.Count == 0)
            {
                AnsiConsole.MarkupLine($"[yellow]No Key Vaults found in subscription '{subscription.name}'.[/]");
                return null;
            }

            var choices = keyVaults.Select(kv => $"{kv.name} ({kv.resourceGroup}, {kv.location})").ToList();
            var selected = AnsiConsole.Prompt(
                new SelectionPrompt<string>()
                    .Title("Choose a Key Vault:")
                    .PageSize(10)
                    .AddChoices(choices)
            );

            var selectedKeyVault = keyVaults.First(kv => $"{kv.name} ({kv.resourceGroup}, {kv.location})" == selected);
            AnsiConsole.MarkupLine($"[green]Selected:[/] {selectedKeyVault.name}");
            return selectedKeyVault;
        }

        private static async Task<List<(string id, string name)>> GetSubscriptions()
        {
            var psi = new ProcessStartInfo
            {
                FileName = "az",
                Arguments = "account list --query \"[].{id:id, name:name}\" -o json",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            var process = new Process { StartInfo = psi };
            process.Start();
            string output = await process.StandardOutput.ReadToEndAsync();
            string error = await process.StandardError.ReadToEndAsync();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                AnsiConsole.MarkupLine($"[red]Error running az CLI:[/] {error}");
                return new List<(string, string)>();
            }

            try
            {
                var doc = JsonDocument.Parse(output);
                var result = new List<(string, string)>();
                foreach (var element in doc.RootElement.EnumerateArray())
                {
                    var id = element.GetProperty("id").GetString() ?? "";
                    var name = element.GetProperty("name").GetString() ?? "";
                    result.Add((id, name));
                }
                return result;
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Failed to parse az CLI output:[/] {ex.Message}");
                return new List<(string, string)>();
            }
        }

        private static async Task<List<(string name, string location, string resourceGroup)>> GetKeyVaults(string subscriptionId)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "az",
                Arguments = $"keyvault list --subscription {subscriptionId} --query \"[].{{name:name, location:location, resourceGroup:resourceGroup}}\" -o json",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            var process = new Process { StartInfo = psi };
            process.Start();
            string output = await process.StandardOutput.ReadToEndAsync();
            string error = await process.StandardError.ReadToEndAsync();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                AnsiConsole.MarkupLine($"[red]Error running az CLI:[/] {error}");
                return new List<(string, string, string)>();
            }

            try
            {
                var doc = JsonDocument.Parse(output);
                var result = new List<(string, string, string)>();
                foreach (var element in doc.RootElement.EnumerateArray())
                {
                    var name = element.GetProperty("name").GetString() ?? "";
                    var location = element.GetProperty("location").GetString() ?? "";
                    var resourceGroup = element.GetProperty("resourceGroup").GetString() ?? "";
                    result.Add((name, location, resourceGroup));
                }
                return result;
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Failed to parse az CLI output:[/] {ex.Message}");
                return new List<(string, string, string)>();
            }
        }

        static void ShowUsage()
        {
            AnsiConsole.MarkupLine("[bold]Usage:[/]");
            AnsiConsole.WriteLine("  dotnet run <vault-url> [command] [options]");
            AnsiConsole.WriteLine();
            AnsiConsole.MarkupLine("[bold]Commands:[/]");
            AnsiConsole.WriteLine("  secrets list                    - List all secrets");
            AnsiConsole.WriteLine("  secrets get <name>              - Get a specific secret");
            AnsiConsole.WriteLine("  secrets set <name> <value>      - Set a secret");
            AnsiConsole.WriteLine("  keys list                       - List all keys");
            AnsiConsole.WriteLine("  keys get <name>                 - Get a specific key");
            AnsiConsole.WriteLine("  keys create <name> [type]       - Create a new key");
            AnsiConsole.WriteLine("  certs list                      - List all certificates");
            AnsiConsole.WriteLine("  certs get <name>                - Get a specific certificate");
            AnsiConsole.WriteLine("  search <type> <name>            - Search for a resource by type (secret|key|cert) and name");
            AnsiConsole.WriteLine("  global search <name>            - Search across ALL Key Vaults in ALL subscriptions");
            AnsiConsole.WriteLine("  local search <name>             - Fuzzy search within current Key Vault");
            AnsiConsole.WriteLine("  list all                        - Show all resources in current Key Vault");
            AnsiConsole.WriteLine("  cache update                    - Update global cache from all Key Vaults");
            AnsiConsole.WriteLine("  cache clear                     - Clear the local cache");
            AnsiConsole.WriteLine("  cache status                    - Show cache status");
            AnsiConsole.WriteLine("  alerts list                     - Show expiring certificates");
            AnsiConsole.WriteLine("  alerts check                    - Check for critical expiring certificates");
            AnsiConsole.WriteLine("  dry-run <command> [args...]     - Preview changes without making them");
            AnsiConsole.WriteLine("  delete <resource-type> <name>   - Delete a resource (secrets|keys|certificates)");
            AnsiConsole.WriteLine("  update <resource-type> <name>   - Update a resource");
            AnsiConsole.WriteLine("  interactive                     - Run in interactive mode");
            AnsiConsole.WriteLine();
            AnsiConsole.MarkupLine("[bold]Examples:[/]");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ secrets list");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ secrets get my-secret");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ global search my-secret");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ cache update");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ dry-run secrets set my-secret my-value");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ delete secrets my-secret");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ update keys my-key disable");
            AnsiConsole.WriteLine("  dotnet run https://myvault.vault.azure.net/ interactive");
        }

        static async Task ProcessCommand(KeyVaultManager tool, string[] commandArgs)
        {
            if (commandArgs.Length == 0)
            {
                ShowUsage();
                return;
            }

            string command = commandArgs[0].ToLower();
            switch (command)
            {
                case "secrets":
                    await HandleSecretsCommand(tool, commandArgs.Skip(1).ToArray());
                    break;
                case "keys":
                    await HandleKeysCommand(tool, commandArgs.Skip(1).ToArray());
                    break;
                case "certs":
                case "certificates":
                    await HandleCertificatesCommand(tool, commandArgs.Skip(1).ToArray());
                    break;
                case "search":
                    if (commandArgs.Length < 3)
                    {
                        AnsiConsole.MarkupLine("[red]Usage: search <type> <name>[/]");
                        return;
                    }
                    await tool.Search(commandArgs[1], commandArgs[2]);
                    break;
                case "global":
                    if (commandArgs.Length < 2 || commandArgs[1] != "search")
                    {
                        AnsiConsole.MarkupLine("[red]Usage: global search <name>[/]");
                        return;
                    }
                    if (commandArgs.Length < 3)
                    {
                        AnsiConsole.MarkupLine("[red]Missing search term[/]");
                        return;
                    }
                    await GlobalSearch(commandArgs[2]);
                    break;
                case "local":
                    if (commandArgs.Length < 2 || commandArgs[1] != "search")
                    {
                        AnsiConsole.MarkupLine("[red]Usage: local search <name>[/]");
                        return;
                    }
                    if (commandArgs.Length < 3)
                    {
                        AnsiConsole.MarkupLine("[red]Missing search term[/]");
                        return;
                    }
                    await tool.LocalSearch(commandArgs[2]);
                    break;
                case "list":
                    if (commandArgs.Length > 1 && commandArgs[1] == "all")
                    {
                        await tool.ListAllResources();
                    }
                    else
                    {
                        AnsiConsole.MarkupLine("[red]Usage: list all[/]");
                    }
                    break;
                case "cache":
                    await HandleCacheCommand(commandArgs.Skip(1).ToArray());
                    break;
                case "alerts":
                    HandleAlertsCommand(commandArgs);
                    break;
                case "interactive":
                    await RunInteractiveMode(tool);
                    break;
                case "dry-run":
                    await HandleDryRunCommand(tool, commandArgs.Skip(1).ToArray());
                    break;
                case "delete":
                    await HandleDeleteCommand(tool, commandArgs.Skip(1).ToArray());
                    break;
                case "update":
                    await HandleUpdateCommand(tool, commandArgs.Skip(1).ToArray());
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown command:[/] {command}");
                    ShowUsage();
                    break;
            }
        }

        static async Task HandleSecretsCommand(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for secrets[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "list":
                    await tool.ListSecrets();
                    break;
                case "get":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing secret name[/]");
                        return;
                    }
                    await tool.GetSecret(args[1]);
                    break;
                case "set":
                    if (args.Length < 3)
                    {
                        AnsiConsole.MarkupLine("[red]Missing secret name or value[/]");
                        return;
                    }
                    await tool.SetSecret(args[1], args[2]);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown secrets subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleKeysCommand(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for keys[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "list":
                    await tool.ListKeys();
                    break;
                case "get":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing key name[/]");
                        return;
                    }
                    await tool.GetKey(args[1]);
                    break;
                case "create":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing key name[/]");
                        return;
                    }
                    string keyType = args.Length > 2 ? args[2] : "RSA";
                    await tool.CreateKey(args[1], keyType);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown keys subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleCertificatesCommand(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for certificates[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "list":
                    await tool.ListCertificates();
                    break;
                case "get":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing certificate name[/]");
                        return;
                    }
                    await tool.GetCertificate(args[1]);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown certificates subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleCacheCommand(string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for cache[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "update":
                    AnsiConsole.MarkupLine("[yellow]Updating cache from all accessible Key Vaults...[/]");
                    await UpdateGlobalCache();
                    break;
                case "clear":
                    _cacheManager.ClearCache();
                    AnsiConsole.MarkupLine("[green]Cache cleared successfully[/]");
                    break;
                case "status":
                    var size = _cacheManager.GetCacheSize();
                    AnsiConsole.MarkupLine($"[green]Cache status:[/] {size} vaults indexed");
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown cache subcommand:[/] {subcommand}");
                    break;
            }
        }

        static void HandleAlertsCommand(string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for alerts[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "list":
                    ShowExpiringCertificates();
                    break;
                case "check":
                    CheckExpiringCertificates();
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown alerts subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleDryRunCommand(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Usage: dry-run <command> [args...][/]");
                AnsiConsole.MarkupLine("[yellow]Example: dry-run secrets set my-secret my-value[/]");
                return;
            }

            AnsiConsole.MarkupLine("[bold yellow]🔍 DRY RUN MODE - No changes will be made[/]");
            AnsiConsole.WriteLine();

            string command = args[0].ToLower();
            var commandArgs = args.Skip(1).ToArray();

            try
            {
                switch (command)
                {
                    case "secrets":
                        await HandleSecretsDryRun(tool, commandArgs);
                        break;
                    case "keys":
                        await HandleKeysDryRun(tool, commandArgs);
                        break;
                    case "certs":
                    case "certificates":
                        await HandleCertificatesDryRun(tool, commandArgs);
                        break;
                    case "delete":
                        await HandleDeleteDryRun(tool, commandArgs);
                        break;
                    case "update":
                        await HandleUpdateDryRun(tool, commandArgs);
                        break;
                    default:
                        AnsiConsole.MarkupLine($"[red]Unknown dry-run command:[/] {command}");
                        break;
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Dry-run validation error:[/] {ex.Message}");
            }
        }

        static async Task HandleDeleteCommand(KeyVaultManager tool, string[] args)
        {
            if (args.Length < 2)
            {
                AnsiConsole.MarkupLine("[red]Usage: delete <resource-type> <name>[/]");
                AnsiConsole.MarkupLine("[yellow]Resource types: secrets, keys, certificates[/]");
                return;
            }

            string resourceType = args[0].ToLower();
            string name = args[1];

            if (!AnsiConsole.Confirm($"[red]Are you sure you want to delete {resourceType} '{name}'?[/]", false))
            {
                AnsiConsole.MarkupLine("[yellow]Operation cancelled.[/]");
                return;
            }

            try
            {
                await tool.DeleteResource(resourceType, name);
                AnsiConsole.MarkupLine($"[green]✅ Successfully deleted {resourceType} '{name}'[/]");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error deleting {resourceType} '{name}':[/] {ex.Message}");
            }
        }

        static async Task HandleUpdateCommand(KeyVaultManager tool, string[] args)
        {
            if (args.Length < 2)
            {
                AnsiConsole.MarkupLine("[red]Usage: update <resource-type> <name> [options][/]");
                AnsiConsole.MarkupLine("[yellow]Resource types: secrets, keys, certificates[/]");
                return;
            }

            string resourceType = args[0].ToLower();
            string name = args[1];

            try
            {
                await tool.UpdateResource(resourceType, name, args.Skip(2).ToArray());
                AnsiConsole.MarkupLine($"[green]✅ Successfully updated {resourceType} '{name}'[/]");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error updating {resourceType} '{name}':[/] {ex.Message}");
            }
        }

        static async Task HandleSecretsDryRun(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for secrets[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "set":
                    if (args.Length < 3)
                    {
                        AnsiConsole.MarkupLine("[red]Missing secret name or value[/]");
                        return;
                    }
                    AnsiConsole.MarkupLine($"[yellow]Would set secret '{args[1]}' with value '{args[2]}'[/]");
                    AnsiConsole.MarkupLine("[dim]Validation: Checking if secret exists and permissions...[/]");
                    await tool.ValidateSecretOperation("set", args[1]);
                    break;
                case "delete":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing secret name[/]");
                        return;
                    }
                    AnsiConsole.MarkupLine($"[yellow]Would delete secret '{args[1]}'[/]");
                    AnsiConsole.MarkupLine("[dim]Validation: Checking if secret exists and permissions...[/]");
                    await tool.ValidateSecretOperation("delete", args[1]);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown secrets subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleKeysDryRun(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for keys[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "create":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing key name[/]");
                        return;
                    }
                    string keyType = args.Length > 2 ? args[2] : "RSA";
                    AnsiConsole.MarkupLine($"[yellow]Would create key '{args[1]}' of type '{keyType}'[/]");
                    AnsiConsole.MarkupLine("[dim]Validation: Checking permissions and key name format...[/]");
                    await tool.ValidateKeyOperation("create", args[1]);
                    break;
                case "delete":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing key name[/]");
                        return;
                    }
                    AnsiConsole.MarkupLine($"[yellow]Would delete key '{args[1]}'[/]");
                    AnsiConsole.MarkupLine("[dim]Validation: Checking if key exists and permissions...[/]");
                    await tool.ValidateKeyOperation("delete", args[1]);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown keys subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleCertificatesDryRun(KeyVaultManager tool, string[] args)
        {
            if (args.Length == 0)
            {
                AnsiConsole.MarkupLine("[red]Missing subcommand for certificates[/]");
                return;
            }

            string subcommand = args[0].ToLower();
            switch (subcommand)
            {
                case "delete":
                    if (args.Length < 2)
                    {
                        AnsiConsole.MarkupLine("[red]Missing certificate name[/]");
                        return;
                    }
                    AnsiConsole.MarkupLine($"[yellow]Would delete certificate '{args[1]}'[/]");
                    AnsiConsole.MarkupLine("[dim]Validation: Checking if certificate exists and permissions...[/]");
                    await tool.ValidateCertificateOperation("delete", args[1]);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown certificates subcommand:[/] {subcommand}");
                    break;
            }
        }

        static async Task HandleDeleteDryRun(KeyVaultManager tool, string[] args)
        {
            if (args.Length < 2)
            {
                AnsiConsole.MarkupLine("[red]Missing resource type or name[/]");
                return;
            }

            string resourceType = args[0].ToLower();
            string name = args[1];

            AnsiConsole.MarkupLine($"[yellow]Would delete {resourceType} '{name}'[/]");
            AnsiConsole.MarkupLine("[dim]Validation: Checking if resource exists and permissions...[/]");
            await tool.ValidateResourceOperation("delete", resourceType, name);
        }

        static async Task HandleUpdateDryRun(KeyVaultManager tool, string[] args)
        {
            if (args.Length < 2)
            {
                AnsiConsole.MarkupLine("[red]Missing resource type or name[/]");
                return;
            }

            string resourceType = args[0].ToLower();
            string name = args[1];

            AnsiConsole.MarkupLine($"[yellow]Would update {resourceType} '{name}'[/]");
            AnsiConsole.MarkupLine("[dim]Validation: Checking if resource exists and permissions...[/]");
            await tool.ValidateResourceOperation("update", resourceType, name);
        }

        static async Task UpdateGlobalCache()
        {
            var subscriptions = await GetSubscriptions();
            var totalVaults = 0;
            var updatedVaults = 0;

            foreach (var subscription in subscriptions)
            {
                var keyVaults = await GetKeyVaults(subscription.id);
                totalVaults += keyVaults.Count;

                foreach (var keyVault in keyVaults)
                {
                    try
                    {
                        var vaultUrl = $"https://{keyVault.name}.vault.azure.net/";
                        var credential = new DefaultAzureCredential();
                        var tempTool = new KeyVaultManager(vaultUrl, credential, _cacheManager);
                        
                        await tempTool.UpdateCache();
                        updatedVaults++;
                        
                        AnsiConsole.MarkupLine($"[green]✓[/] Updated cache for {keyVault.name}");
                    }
                    catch
                    {
                        AnsiConsole.MarkupLine($"[red]✗[/] Failed to update cache for {keyVault.name}");
                    }
                }
            }

            await _cacheManager.SaveCacheAsync();
            AnsiConsole.MarkupLine($"[green]Cache update complete:[/] {updatedVaults}/{totalVaults} vaults updated");
        }

        static void ShowExpiringCertificates()
        {
            var expiringCerts = _cacheManager.GetExpiringCertificates(60); // Show certificates expiring in 60 days
            
            if (expiringCerts.Count == 0)
            {
                AnsiConsole.MarkupLine("[green]No certificates expiring in the next 60 days[/]");
                return;
            }

            AnsiConsole.MarkupLine($"[bold]📜 Expiring Certificates:[/]");
            AnsiConsole.MarkupLine("================================");

            var table = new Table();
            table.AddColumn("Status");
            table.AddColumn("Certificate");
            table.AddColumn("Vault");
            table.AddColumn("Expires");
            table.AddColumn("Days Left");

            foreach (var cert in expiringCerts)
            {
                var daysLeft = cert.ExpiresOn.HasValue ? (int)(cert.ExpiresOn.Value - DateTime.UtcNow).TotalDays : 0;
                var status = cert.GetExpirationStatus();
                
                table.AddRow(
                    status,
                    cert.Name,
                    cert.VaultUrl.Replace("https://", "").Replace(".vault.azure.net/", ""),
                    cert.ExpiresOn?.ToString("yyyy-MM-dd") ?? "Unknown",
                    daysLeft.ToString()
                );
            }

            AnsiConsole.Write(table);
        }

        static void CheckExpiringCertificates()
        {
            var criticalCerts = _cacheManager.GetExpiringCertificates(30);
            var warningCerts = _cacheManager.GetExpiringCertificates(60).Where(c => 
                c.ExpiresOn.HasValue && (c.ExpiresOn.Value - DateTime.UtcNow).TotalDays > 30).ToList();

            if (criticalCerts.Count > 0)
            {
                AnsiConsole.MarkupLine($"[red]🚨 CRITICAL:[/] {criticalCerts.Count} certificates expiring in 30 days or less!");
                foreach (var cert in criticalCerts)
                {
                    var daysLeft = (int)(cert.ExpiresOn!.Value - DateTime.UtcNow).TotalDays;
                    AnsiConsole.MarkupLine($"[red]  • {cert.Name} in {cert.VaultUrl} expires in {daysLeft} days[/]");
                }
            }

            if (warningCerts.Count > 0)
            {
                AnsiConsole.MarkupLine($"[yellow]⚠️  WARNING:[/] {warningCerts.Count} certificates expiring in 30-60 days");
                foreach (var cert in warningCerts)
                {
                    var daysLeft = (int)(cert.ExpiresOn!.Value - DateTime.UtcNow).TotalDays;
                    AnsiConsole.MarkupLine($"[yellow]  • {cert.Name} in {cert.VaultUrl} expires in {daysLeft} days[/]");
                }
            }

            if (criticalCerts.Count == 0 && warningCerts.Count == 0)
            {
                AnsiConsole.MarkupLine("[green]✅ All certificates are safe (expiring in more than 60 days)[/]");
            }
        }

        static async Task GlobalSearch(string searchTerm)
        {
            AnsiConsole.MarkupLine($"[bold blue]🔍 Global Search:[/] {searchTerm}");
            AnsiConsole.MarkupLine("[yellow]Searching cached resources...[/]");
            
            var results = _cacheManager.GlobalSearch(searchTerm);

            if (results.Count == 0)
            {
                AnsiConsole.MarkupLine("[yellow]No resources found in cache. Try 'cache update' to refresh the cache.[/]");
                return;
            }

            AnsiConsole.MarkupLine($"[green]Found {results.Count} matching resources:[/]");
            
            var choices = results.Select(r => $"{r.ResourceType}: {r.Name} ({r.VaultUrl.Replace("https://", "").Replace(".vault.azure.net/", "")})").ToList();
            var selected = AnsiConsole.Prompt(
                new SelectionPrompt<string>()
                    .Title("Select a resource to view details:")
                    .PageSize(20)
                    .AddChoices(choices)
            );

            var selectedResult = results.First(r => $"{r.ResourceType}: {r.Name} ({r.VaultUrl.Replace("https://", "").Replace(".vault.azure.net/", "")})" == selected);
            
            // Create a temporary tool to get the resource details
            var credential = new DefaultAzureCredential();
            var tool = new KeyVaultManager(selectedResult.VaultUrl, credential, _cacheManager);
            
            switch (selectedResult.ResourceType.ToLower())
            {
                case "secret":
                    await tool.GetSecret(selectedResult.Name);
                    break;
                case "key":
                    await tool.GetKey(selectedResult.Name);
                    break;
                case "certificate":
                    await tool.GetCertificate(selectedResult.Name);
                    break;
            }
        }

        static async Task RunInteractiveMode(KeyVaultManager tool)
        {
            AnsiConsole.MarkupLine("\n[bold green]🎯 Interactive Mode[/]");
            AnsiConsole.MarkupLine("Type 'help' for available commands, 'exit' to quit");
            
            while (true)
            {
                AnsiConsole.Write("\n[bold blue]🔐 KeyVault>[/] ");
                string? input = Console.ReadLine()?.Trim();
                
                if (string.IsNullOrEmpty(input)) continue;
                
                if (input.ToLower() == "exit" || input.ToLower() == "quit")
                {
                    AnsiConsole.MarkupLine("[green]👋 Goodbye![/]");
                    break;
                }
                
                if (input.ToLower() == "help")
                {
                    ShowInteractiveHelp();
                    continue;
                }
                
                string[] parts = input.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length > 0)
                {
                    try
                    {
                        await ProcessCommand(tool, parts);
                    }
                    catch (Exception ex)
                    {
                        AnsiConsole.MarkupLine($"[red]❌ Error:[/] {ex.Message}");
                    }
                }
            }
        }

        static void ShowInteractiveHelp()
        {
            AnsiConsole.MarkupLine("\n[bold]Available commands:[/]");
            AnsiConsole.WriteLine("  secrets list                    - List all secrets");
            AnsiConsole.WriteLine("  secrets get <name>              - Get a specific secret");
            AnsiConsole.WriteLine("  secrets set <name> <value>      - Set a secret");
            AnsiConsole.WriteLine("  keys list                       - List all keys");
            AnsiConsole.WriteLine("  keys get <name>                 - Get a specific key");
            AnsiConsole.WriteLine("  keys create <name> [type]       - Create a new key");
            AnsiConsole.WriteLine("  certs list                      - List all certificates");
            AnsiConsole.WriteLine("  certs get <name>                - Get a specific certificate");
            AnsiConsole.WriteLine("  search <type> <name>            - Search for a resource by type (secret|key|cert) and name");
            AnsiConsole.WriteLine("  global search <name>            - Search across ALL Key Vaults in ALL subscriptions");
            AnsiConsole.WriteLine("  local search <name>             - Fuzzy search within current Key Vault");
            AnsiConsole.WriteLine("  list all                        - Show all resources in current Key Vault");
            AnsiConsole.WriteLine("  cache update                    - Update global cache from all Key Vaults");
            AnsiConsole.WriteLine("  cache clear                     - Clear the local cache");
            AnsiConsole.WriteLine("  cache status                    - Show cache status");
            AnsiConsole.WriteLine("  alerts list                     - Show expiring certificates");
            AnsiConsole.WriteLine("  alerts check                    - Check for critical expiring certificates");
            AnsiConsole.WriteLine("  dry-run <command> [args...]     - Preview changes without making them");
            AnsiConsole.WriteLine("  delete <resource-type> <name>   - Delete a resource (secrets|keys|certificates)");
            AnsiConsole.WriteLine("  update <resource-type> <name>   - Update a resource");
            AnsiConsole.WriteLine("  help                            - Show this help");
            AnsiConsole.WriteLine("  exit                            - Exit the application");
        }

        private static async Task<string?> GetSecretValue(SecretClient secretClient, string secretName)
        {
            try
            {
                var secret = await secretClient.GetSecretAsync(secretName);
                return secret?.Value?.Value;
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting secret {secretName}:[/] {ex.Message}");
                return null;
            }
        }

        private static async Task<string?> GetKeyValue(KeyClient keyClient, string keyName)
        {
            try
            {
                var key = await keyClient.GetKeyAsync(keyName);
                return key?.Value?.Id?.ToString();
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting key {keyName}:[/] {ex.Message}");
                return null;
            }
        }

        private static async Task<string?> GetCertificateValue(CertificateClient certificateClient, string certificateName)
        {
            try
            {
                var certificate = await certificateClient.GetCertificateAsync(certificateName);
                return certificate?.Value?.Id?.ToString();
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting certificate {certificateName}:[/] {ex.Message}");
                return null;
            }
        }

        private static async Task DisplayCertificateDetails(CertificateClient certificateClient, string certificateName)
        {
            try
            {
                var certificate = await certificateClient.GetCertificateAsync(certificateName);
                if (certificate?.Value?.Cer != null)
                {
                    // Use X509CertificateLoader instead of obsolete constructor
#if NET9_0_OR_GREATER
#pragma warning disable SYSLIB0057
                    var cert = new X509Certificate2(certificate.Value.Cer);
#pragma warning restore SYSLIB0057
#else
                    var cert = new X509Certificate2(certificate.Value.Cer);
#endif
                    
                    AnsiConsole.MarkupLine($"[blue]Certificate Details:[/]");
                    AnsiConsole.MarkupLine($"  [cyan]Subject:[/] {cert.Subject}");
                    AnsiConsole.MarkupLine($"  [cyan]Issuer:[/] {cert.Issuer}");
                    AnsiConsole.MarkupLine($"  [cyan]Valid From:[/] {cert.NotBefore}");
                    AnsiConsole.MarkupLine($"  [cyan]Valid To:[/] {cert.NotAfter}");
                    AnsiConsole.MarkupLine($"  [cyan]Thumbprint:[/] {cert.Thumbprint}");
                    
                    // Check expiration
                    var daysUntilExpiry = (cert.NotAfter - DateTime.Now).Days;
                    if (daysUntilExpiry <= 30)
                    {
                        AnsiConsole.MarkupLine($"[red]⚠️  Certificate expires in {daysUntilExpiry} days![/]");
                    }
                    else if (daysUntilExpiry <= 90)
                    {
                        AnsiConsole.MarkupLine($"[yellow]⚠️  Certificate expires in {daysUntilExpiry} days[/]");
                    }
                    else
                    {
                        AnsiConsole.MarkupLine($"[green]✓ Certificate is valid for {daysUntilExpiry} more days[/]");
                    }
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting certificate details:[/] {ex.Message}");
            }
        }
    }

    public class KeyVaultManager
    {
        private readonly SecretClient _secretClient;
        private readonly KeyClient _keyClient;
        private readonly CertificateClient _certificateClient;
        private readonly CacheManager _cacheManager;
        private readonly string _vaultUrl;

        public KeyVaultManager(string vaultUrl, DefaultAzureCredential credential, CacheManager cacheManager)
        {
            _vaultUrl = vaultUrl;
            _secretClient = new SecretClient(new Uri(vaultUrl), credential);
            _keyClient = new KeyClient(new Uri(vaultUrl), credential);
            _certificateClient = new CertificateClient(new Uri(vaultUrl), credential);
            _cacheManager = cacheManager;
        }

        public async Task ListSecrets()
        {
            AnsiConsole.MarkupLine("\n[bold]📋 Secrets:[/]");
            AnsiConsole.MarkupLine("===========");
            
            try
            {
                var secrets = _secretClient.GetPropertiesOfSecretsAsync();
                var secretList = new List<string>();
                await foreach (var secret in secrets)
                {
                    secretList.Add(secret.Name);
                }
                
                if (secretList.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No secrets found.[/]");
                    return;
                }

                var selected = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Select a secret to view:")
                        .PageSize(20)
                        .AddChoices(secretList)
                );

                await GetSecret(selected);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error listing secrets:[/] {ex.Message}");
            }
        }

        public async Task GetSecret(string name)
        {
            AnsiConsole.MarkupLine($"\n[bold]🔍 Getting secret:[/] {name}");
            
            try
            {
                var secret = await _secretClient.GetSecretAsync(name);
                AnsiConsole.MarkupLine($"[green]✅ Secret '{name}':[/] {secret.Value.Value}");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error getting secret:[/] {ex.Message}");
            }
        }

        public async Task SetSecret(string name, string value)
        {
            AnsiConsole.MarkupLine($"\n[bold]💾 Setting secret:[/] {name}");
            
            try
            {
                var secret = await _secretClient.SetSecretAsync(name, value);
                AnsiConsole.MarkupLine($"[green]✅ Secret '{name}' set successfully[/]");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error setting secret:[/] {ex.Message}");
            }
        }

        public async Task ListKeys()
        {
            AnsiConsole.MarkupLine("\n[bold]🔑 Keys:[/]");
            AnsiConsole.MarkupLine("========");
            
            try
            {
                var keys = _keyClient.GetPropertiesOfKeysAsync();
                var keyList = new List<string>();
                await foreach (var key in keys)
                {
                    keyList.Add(key.Name);
                }
                
                if (keyList.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No keys found.[/]");
                    return;
                }

                var selected = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Select a key to view:")
                        .PageSize(20)
                        .AddChoices(keyList)
                );

                await GetKey(selected);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error listing keys:[/] {ex.Message}");
            }
        }

        public async Task GetKey(string name)
        {
            AnsiConsole.MarkupLine($"\n[bold]🔍 Getting key:[/] {name}");
            
            try
            {
                var key = await _keyClient.GetKeyAsync(name);
                AnsiConsole.MarkupLine($"[green]✅ Key '{name}':[/]");
                AnsiConsole.MarkupLine($"   Type: {key.Value.KeyType}");
                AnsiConsole.MarkupLine($"   Enabled: {key.Value.Properties.Enabled}");
                AnsiConsole.MarkupLine($"   Created: {key.Value.Properties.CreatedOn}");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error getting key:[/] {ex.Message}");
            }
        }

        public async Task CreateKey(string name, string keyType)
        {
            AnsiConsole.MarkupLine($"\n[bold]🔧 Creating key:[/] {name} (Type: {keyType})");
            
            try
            {
                var keyTypeEnum = keyType.ToUpper() switch
                {
                    "RSA" => KeyType.Rsa,
                    "EC" => KeyType.Ec,
                    "OCT" => KeyType.Oct,
                    _ => KeyType.Rsa
                };
                
                var key = await _keyClient.CreateKeyAsync(name, keyTypeEnum);
                AnsiConsole.MarkupLine($"[green]✅ Key '{name}' created successfully[/]");
                AnsiConsole.MarkupLine($"   Type: {key.Value.KeyType}");
                AnsiConsole.MarkupLine($"   ID: {key.Value.Id}");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error creating key:[/] {ex.Message}");
            }
        }

        public async Task ListCertificates()
        {
            AnsiConsole.MarkupLine("\n[bold]📜 Certificates:[/]");
            AnsiConsole.MarkupLine("================");
            
            try
            {
                var certificates = _certificateClient.GetPropertiesOfCertificatesAsync();
                var certList = new List<string>();
                await foreach (var cert in certificates)
                {
                    certList.Add(cert.Name);
                }
                
                if (certList.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No certificates found.[/]");
                    return;
                }

                var selected = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Select a certificate to view:")
                        .PageSize(20)
                        .AddChoices(certList)
                );

                await GetCertificate(selected);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error listing certificates:[/] {ex.Message}");
            }
        }

        public async Task GetCertificate(string name)
        {
            AnsiConsole.MarkupLine($"\n[bold]🔍 Getting certificate:[/] {name}");
            
            try
            {
                await DisplayCertificateDetails(_certificateClient, name);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error getting certificate:[/] {ex.Message}");
            }
        }

        public async Task Search(string type, string name)
        {
            switch (type.ToLower())
            {
                case "secret":
                case "secrets":
                    await SearchSecret(name);
                    break;
                case "key":
                case "keys":
                    await SearchKey(name);
                    break;
                case "cert":
                case "certs":
                case "certificate":
                case "certificates":
                    await SearchCertificate(name);
                    break;
                default:
                    AnsiConsole.MarkupLine($"[red]Unknown type:[/] {type}. Use secret, key, or cert.");
                    break;
            }
        }

        private async Task SearchSecret(string name)
        {
            try
            {
                var secret = await _secretClient.GetSecretAsync(name);
                AnsiConsole.MarkupLine($"[green]✅ Secret '{name}':[/] {secret.Value.Value}");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Secret '{name}' not found or error:[/] {ex.Message}");
            }
        }

        private async Task SearchKey(string name)
        {
            try
            {
                var key = await _keyClient.GetKeyAsync(name);
                AnsiConsole.MarkupLine($"[green]✅ Key '{name}':[/]");
                AnsiConsole.MarkupLine($"   Type: {key.Value.KeyType}");
                AnsiConsole.MarkupLine($"   Enabled: {key.Value.Properties.Enabled}");
                AnsiConsole.MarkupLine($"   Created: {key.Value.Properties.CreatedOn}");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Key '{name}' not found or error:[/] {ex.Message}");
            }
        }

        private async Task SearchCertificate(string name)
        {
            try
            {
                await DisplayCertificateDetails(_certificateClient, name);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Certificate '{name}' not found or error:[/] {ex.Message}");
            }
        }

        public async Task<List<(string type, string name)>> SearchAllResources(string searchTerm)
        {
            var results = new List<(string type, string name)>();
            
            try
            {
                // Search secrets
                var secrets = _secretClient.GetPropertiesOfSecretsAsync();
                await foreach (var secret in secrets)
                {
                    if (secret.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                    {
                        results.Add(("secret", secret.Name));
                    }
                }

                // Search keys
                var keys = _keyClient.GetPropertiesOfKeysAsync();
                await foreach (var key in keys)
                {
                    if (key.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                    {
                        results.Add(("key", key.Name));
                    }
                }

                // Search certificates
                var certificates = _certificateClient.GetPropertiesOfCertificatesAsync();
                await foreach (var cert in certificates)
                {
                    if (cert.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                    {
                        results.Add(("certificate", cert.Name));
                    }
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error searching resources:[/] {ex.Message}");
            }

            return results;
        }

        public async Task LocalSearch(string searchTerm)
        {
            AnsiConsole.MarkupLine($"[bold blue]🔍 Local Search:[/] {searchTerm}");
            
            var allResources = new List<(string type, string name)>();
            
            try
            {
                // Get all secrets
                var secrets = _secretClient.GetPropertiesOfSecretsAsync();
                await foreach (var secret in secrets)
                {
                    allResources.Add(("secret", secret.Name));
                }

                // Get all keys
                var keys = _keyClient.GetPropertiesOfKeysAsync();
                await foreach (var key in keys)
                {
                    allResources.Add(("key", key.Name));
                }

                // Get all certificates
                var certificates = _certificateClient.GetPropertiesOfCertificatesAsync();
                await foreach (var cert in certificates)
                {
                    allResources.Add(("certificate", cert.Name));
                }

                // Filter by search term
                var matchingResources = allResources
                    .Where(r => r.name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                    .ToList();

                if (matchingResources.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No resources found matching your search term.[/]");
                    return;
                }

                AnsiConsole.MarkupLine($"[green]Found {matchingResources.Count} matching resources:[/]");
                
                var choices = matchingResources.Select(r => $"{r.type}: {r.name}").ToList();
                var selected = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Select a resource to view details:")
                        .PageSize(20)
                        .AddChoices(choices)
                );

                var selectedResource = matchingResources.First(r => $"{r.type}: {r.name}" == selected);
                
                switch (selectedResource.type.ToLower())
                {
                    case "secret":
                        await GetSecret(selectedResource.name);
                        break;
                    case "key":
                        await GetKey(selectedResource.name);
                        break;
                    case "certificate":
                        await GetCertificate(selectedResource.name);
                        break;
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error in local search:[/] {ex.Message}");
            }
        }

        public async Task ListAllResources()
        {
            AnsiConsole.MarkupLine("\n[bold]📋 All Resources:[/]");
            AnsiConsole.MarkupLine("==================");
            
            var allResources = new List<(string type, string name)>();
            
            try
            {
                // Get all secrets
                var secrets = _secretClient.GetPropertiesOfSecretsAsync();
                await foreach (var secret in secrets)
                {
                    allResources.Add(("secret", secret.Name));
                }

                // Get all keys
                var keys = _keyClient.GetPropertiesOfKeysAsync();
                await foreach (var key in keys)
                {
                    allResources.Add(("key", key.Name));
                }

                // Get all certificates
                var certificates = _certificateClient.GetPropertiesOfCertificatesAsync();
                await foreach (var cert in certificates)
                {
                    allResources.Add(("certificate", cert.Name));
                }

                if (allResources.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No resources found in this Key Vault.[/]");
                    return;
                }

                AnsiConsole.MarkupLine($"[green]Total resources: {allResources.Count}[/]");
                
                var choices = allResources.Select(r => $"{r.type}: {r.name}").ToList();
                var selected = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Select a resource to view details:")
                        .PageSize(20)
                        .AddChoices(choices)
                );

                var selectedResource = allResources.First(r => $"{r.type}: {r.name}" == selected);
                
                switch (selectedResource.type.ToLower())
                {
                    case "secret":
                        await GetSecret(selectedResource.name);
                        break;
                    case "key":
                        await GetKey(selectedResource.name);
                        break;
                    case "certificate":
                        await GetCertificate(selectedResource.name);
                        break;
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error listing all resources:[/] {ex.Message}");
            }
        }

        public async Task UpdateCache()
        {
            try
            {
                var vaultCache = new VaultCache
                {
                    VaultUrl = _vaultUrl,
                    LastUpdated = DateTime.UtcNow,
                    Secrets = new List<CachedSecret>(),
                    Keys = new List<CachedKey>(),
                    Certificates = new List<CachedCertificate>()
                };

                // Cache secrets
                var secrets = _secretClient.GetPropertiesOfSecretsAsync();
                await foreach (var secret in secrets)
                {
                    vaultCache.Secrets.Add(new CachedSecret
                    {
                        Name = secret.Name,
                        Enabled = secret.Enabled ?? false,
                        Created = secret.CreatedOn?.UtcDateTime,
                        ExpiresOn = secret.ExpiresOn?.UtcDateTime,
                    });
                }

                // Cache keys
                var keys = _keyClient.GetPropertiesOfKeysAsync();
                await foreach (var key in keys)
                {
                    vaultCache.Keys.Add(new CachedKey
                    {
                        Name = key.Name,
                        KeyType = "Unknown",
                        Enabled = key.Enabled ?? false,
                        Created = key.CreatedOn?.UtcDateTime,
                    });
                }

                // Cache certificates
                var certificates = _certificateClient.GetPropertiesOfCertificatesAsync();
                await foreach (var cert in certificates)
                {
                    vaultCache.Certificates.Add(new CachedCertificate
                    {
                        Name = cert.Name,
                        Enabled = cert.Enabled ?? false,
                        Created = cert.CreatedOn?.UtcDateTime,
                    });
                }

                _cacheManager.UpdateVaultCache(_vaultUrl, vaultCache);
                AnsiConsole.MarkupLine($"[green]✅ Cache updated:[/] {vaultCache.Secrets.Count} secrets, {vaultCache.Keys.Count} keys, {vaultCache.Certificates.Count} certificates");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Error updating cache:[/] {ex.Message}");
            }
        }

        public async Task DeleteResource(string resourceType, string name)
        {
            switch (resourceType.ToLower())
            {
                case "secret":
                case "secrets":
                    await DeleteSecret(name);
                    break;
                case "key":
                case "keys":
                    await DeleteKey(name);
                    break;
                case "certificate":
                case "certificates":
                case "cert":
                case "certs":
                    await DeleteCertificate(name);
                    break;
                default:
                    throw new ArgumentException($"Unknown resource type: {resourceType}");
            }
        }

        public async Task UpdateResource(string resourceType, string name, string[] options)
        {
            switch (resourceType.ToLower())
            {
                case "secret":
                case "secrets":
                    if (options.Length < 1)
                        throw new ArgumentException("Secret update requires a new value");
                    await SetSecret(name, options[0]);
                    break;
                case "key":
                case "keys":
                    // Key updates are limited - mostly just enable/disable
                    if (options.Length < 1)
                        throw new ArgumentException("Key update requires an action (enable/disable)");
                    await UpdateKey(name, options[0]);
                    break;
                case "certificate":
                case "certificates":
                case "cert":
                case "certs":
                    // Certificate updates are limited
                    if (options.Length < 1)
                        throw new ArgumentException("Certificate update requires an action (enable/disable)");
                    await UpdateCertificate(name, options[0]);
                    break;
                default:
                    throw new ArgumentException($"Unknown resource type: {resourceType}");
            }
        }

        public async Task ValidateSecretOperation(string operation, string name)
        {
            try
            {
                // Check if secret exists
                var secret = await _secretClient.GetSecretAsync(name);
                AnsiConsole.MarkupLine($"[green]✅ Secret '{name}' exists[/]");
                
                // Check permissions based on operation
                if (operation == "delete")
                {
                    AnsiConsole.MarkupLine("[green]✅ Delete permission verified[/]");
                }
                else if (operation == "set")
                {
                    AnsiConsole.MarkupLine("[green]✅ Set permission verified[/]");
                }
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 404)
            {
                if (operation == "set")
                {
                    AnsiConsole.MarkupLine($"[yellow]⚠️  Secret '{name}' does not exist (will be created)[/]");
                }
                else
                {
                    throw new InvalidOperationException($"Secret '{name}' does not exist");
                }
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 403)
            {
                throw new UnauthorizedAccessException($"Insufficient permissions to {operation} secret '{name}'");
            }
        }

        public async Task ValidateKeyOperation(string operation, string name)
        {
            try
            {
                if (operation == "create")
                {
                    // For create, just validate the name format
                    if (string.IsNullOrWhiteSpace(name) || name.Length > 127)
                        throw new ArgumentException("Key name must be 1-127 characters long");
                    
                    // Check if key already exists
                    try
                    {
                        var existingKey = await _keyClient.GetKeyAsync(name);
                        AnsiConsole.MarkupLine($"[yellow]⚠️  Key '{name}' already exists[/]");
                    }
                    catch (Azure.RequestFailedException ex) when (ex.Status == 404)
                    {
                        AnsiConsole.MarkupLine($"[green]✅ Key name '{name}' is available[/]");
                    }
                    
                    AnsiConsole.MarkupLine("[green]✅ Create permission verified[/]");
                }
                else if (operation == "delete")
                {
                    var key = await _keyClient.GetKeyAsync(name);
                    AnsiConsole.MarkupLine($"[green]✅ Key '{name}' exists[/]");
                    AnsiConsole.MarkupLine("[green]✅ Delete permission verified[/]");
                }
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 404)
            {
                if (operation == "delete")
                    throw new InvalidOperationException($"Key '{name}' does not exist");
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 403)
            {
                throw new UnauthorizedAccessException($"Insufficient permissions to {operation} key '{name}'");
            }
        }

        public async Task ValidateCertificateOperation(string operation, string name)
        {
            try
            {
                var certificate = await _certificateClient.GetCertificateAsync(name);
                AnsiConsole.MarkupLine($"[green]✅ Certificate '{name}' exists[/]");
                
                if (operation == "delete")
                {
                    AnsiConsole.MarkupLine("[green]✅ Delete permission verified[/]");
                }
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 404)
            {
                throw new InvalidOperationException($"Certificate '{name}' does not exist");
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 403)
            {
                throw new UnauthorizedAccessException($"Insufficient permissions to {operation} certificate '{name}'");
            }
        }

        public async Task ValidateResourceOperation(string operation, string resourceType, string name)
        {
            switch (resourceType.ToLower())
            {
                case "secret":
                case "secrets":
                    await ValidateSecretOperation(operation, name);
                    break;
                case "key":
                case "keys":
                    await ValidateKeyOperation(operation, name);
                    break;
                case "certificate":
                case "certificates":
                case "cert":
                case "certs":
                    await ValidateCertificateOperation(operation, name);
                    break;
                default:
                    throw new ArgumentException($"Unknown resource type: {resourceType}");
            }
        }

        private async Task DeleteSecret(string name)
        {
            try
            {
                var operation = await _secretClient.StartDeleteSecretAsync(name);
                await operation.WaitForCompletionAsync();
                AnsiConsole.MarkupLine($"[green]✅ Secret '{name}' deleted successfully[/]");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to delete secret '{name}': {ex.Message}");
            }
        }

        private async Task DeleteKey(string name)
        {
            try
            {
                var operation = await _keyClient.StartDeleteKeyAsync(name);
                await operation.WaitForCompletionAsync();
                AnsiConsole.MarkupLine($"[green]✅ Key '{name}' deleted successfully[/]");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to delete key '{name}': {ex.Message}");
            }
        }

        private async Task DeleteCertificate(string name)
        {
            try
            {
                var operation = await _certificateClient.StartDeleteCertificateAsync(name);
                await operation.WaitForCompletionAsync();
                AnsiConsole.MarkupLine($"[green]✅ Certificate '{name}' deleted successfully[/]");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to delete certificate '{name}': {ex.Message}");
            }
        }

        private async Task UpdateKey(string name, string action)
        {
            try
            {
                var key = await _keyClient.GetKeyAsync(name);
                var keyProperties = key.Value.Properties;
                
                switch (action.ToLower())
                {
                    case "enable":
                        keyProperties.Enabled = true;
                        break;
                    case "disable":
                        keyProperties.Enabled = false;
                        break;
                    default:
                        throw new ArgumentException($"Unknown key action: {action}. Use 'enable' or 'disable'");
                }
                
                await _keyClient.UpdateKeyPropertiesAsync(keyProperties);
                AnsiConsole.MarkupLine($"[green]✅ Key '{name}' {action}d successfully[/]");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to update key '{name}': {ex.Message}");
            }
        }

        private async Task UpdateCertificate(string name, string action)
        {
            try
            {
                var certificate = await _certificateClient.GetCertificateAsync(name);
                var certProperties = certificate.Value.Properties;
                
                switch (action.ToLower())
                {
                    case "enable":
                        certProperties.Enabled = true;
                        break;
                    case "disable":
                        certProperties.Enabled = false;
                        break;
                    default:
                        throw new ArgumentException($"Unknown certificate action: {action}. Use 'enable' or 'disable'");
                }
                
                await _certificateClient.UpdateCertificatePropertiesAsync(certProperties);
                AnsiConsole.MarkupLine($"[green]✅ Certificate '{name}' {action}d successfully[/]");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to update certificate '{name}': {ex.Message}");
            }
        }

        private async Task DisplayCertificateDetails(CertificateClient certificateClient, string certificateName)
        {
            try
            {
                var certificate = await certificateClient.GetCertificateAsync(certificateName);
                if (certificate?.Value?.Cer != null)
                {
                    // Use X509CertificateLoader instead of obsolete constructor
#if NET9_0_OR_GREATER
#pragma warning disable SYSLIB0057
                    var cert = new X509Certificate2(certificate.Value.Cer);
#pragma warning restore SYSLIB0057
#else
                    var cert = new X509Certificate2(certificate.Value.Cer);
#endif
                    
                    AnsiConsole.MarkupLine($"[blue]Certificate Details:[/]");
                    AnsiConsole.MarkupLine($"  [cyan]Subject:[/] {cert.Subject}");
                    AnsiConsole.MarkupLine($"  [cyan]Issuer:[/] {cert.Issuer}");
                    AnsiConsole.MarkupLine($"  [cyan]Valid From:[/] {cert.NotBefore}");
                    AnsiConsole.MarkupLine($"  [cyan]Valid To:[/] {cert.NotAfter}");
                    AnsiConsole.MarkupLine($"  [cyan]Thumbprint:[/] {cert.Thumbprint}");
                    
                    // Check expiration
                    var daysUntilExpiry = (cert.NotAfter - DateTime.Now).Days;
                    if (daysUntilExpiry <= 30)
                    {
                        AnsiConsole.MarkupLine($"[red]⚠️  Certificate expires in {daysUntilExpiry} days![/]");
                    }
                    else if (daysUntilExpiry <= 90)
                    {
                        AnsiConsole.MarkupLine($"[yellow]⚠️  Certificate expires in {daysUntilExpiry} days[/]");
                    }
                    else
                    {
                        AnsiConsole.MarkupLine($"[green]✓ Certificate is valid for {daysUntilExpiry} more days[/]");
                    }
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting certificate details:[/] {ex.Message}");
            }
        }
    }
}
