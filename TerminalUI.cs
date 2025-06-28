using Spectre.Console;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Azure.Security.KeyVault.Secrets;
using Azure.Security.KeyVault.Keys;
using Azure.Security.KeyVault.Certificates;
using Azure.Identity;
using System.Linq;
using System.Text.Json;
using System.Diagnostics;

namespace KeyVaultTool
{
    public enum ViewType
    {
        MainMenu,
        SubscriptionSelect,
        VaultSelect,
        VaultOverview,
        Secrets,
        Keys,
        Certificates,
        GlobalSearch,
        CacheStatus,
        Alerts
    }

    public class NavigationState
    {
        public ViewType CurrentView { get; set; } = ViewType.MainMenu;
        public string? SelectedSubscriptionId { get; set; }
        public string? SelectedSubscriptionName { get; set; }
        public string? SelectedVaultUrl { get; set; }
        public string? SelectedVaultName { get; set; }
        public string? SearchTerm { get; set; }
        public List<string> Breadcrumbs { get; set; } = new List<string>();
    }

    public class TerminalUI
    {
        private readonly CacheManager _cacheManager;
        private readonly NavigationState _navigation;
        private KeyVaultManager? _keyVaultManager;
        private bool _isRunning = true;

        public TerminalUI(CacheManager cacheManager, KeyVaultManager? keyVaultManager = null)
        {
            _cacheManager = cacheManager;
            _keyVaultManager = keyVaultManager;
            _navigation = new NavigationState();
        }

        public async Task RunAsync()
        {
            Console.CursorVisible = false;
            
            while (_isRunning)
            {
                ClearScreen();
                RenderHeader();
                await RenderContent();
                RenderFooter();
                
                await HandleInput();
            }
            
            Console.CursorVisible = true;
        }

        private void ClearScreen()
        {
            Console.Clear();
        }

        private void RenderHeader()
        {
            var rule = new Rule("[blue]Azure Key Vault Tool[/]");
            rule.Justification = Justify.Left;
            AnsiConsole.Write(rule);
            
            // Breadcrumb navigation
            if (_navigation.Breadcrumbs.Count > 0)
            {
                var breadcrumbText = string.Join(" > ", _navigation.Breadcrumbs);
                AnsiConsole.MarkupLine($"[dim]📍 {breadcrumbText}[/]");
            }
            
            AnsiConsole.WriteLine();
        }

        private async Task RenderContent()
        {
            switch (_navigation.CurrentView)
            {
                case ViewType.MainMenu:
                    RenderMainMenu();
                    break;
                case ViewType.VaultSelect:
                    await RenderVaultSelect();
                    break;
                case ViewType.VaultOverview:
                    await RenderVaultOverview();
                    break;
                case ViewType.Secrets:
                    await RenderSecrets();
                    break;
                case ViewType.Keys:
                    await RenderKeys();
                    break;
                case ViewType.Certificates:
                    await RenderCertificates();
                    break;
                case ViewType.GlobalSearch:
                    RenderGlobalSearch();
                    break;
                case ViewType.CacheStatus:
                    RenderCacheStatus();
                    break;
                case ViewType.Alerts:
                    RenderAlerts();
                    break;
            }
        }

        private void RenderFooter()
        {
            AnsiConsole.WriteLine();
            var rule = new Rule();
            rule.Justification = Justify.Left;
            AnsiConsole.Write(rule);
            
            // Show available shortcuts based on current view
            var shortcuts = GetShortcutsForCurrentView();
            AnsiConsole.MarkupLine($"[dim]{shortcuts}[/]");
        }

        private string GetShortcutsForCurrentView()
        {
            return _navigation.CurrentView switch
            {
                ViewType.MainMenu => "ESC Quit  1-7 Select Option",
                ViewType.VaultSelect => "ESC Back",
                ViewType.VaultOverview => "ESC Back  S Secrets  K Keys  C Certs  G Global Search  A Alerts  Q Quit",
                ViewType.Secrets => "ESC Back  S Search  R Refresh  Q Quit",
                ViewType.Keys => "ESC Back  S Search  R Refresh  Q Quit",
                ViewType.Certificates => "ESC Back  S Search  R Refresh  Q Quit",
                ViewType.GlobalSearch => "ESC Back  ENTER Search  Q Quit",
                ViewType.CacheStatus => "ESC Back  R Refresh  Q Quit",
                ViewType.Alerts => "ESC Back  R Refresh  Q Quit",
                _ => "ESC Back  Q Quit"
            };
        }

        private void RenderMainMenu()
        {
            var panel = new Panel(
                new Table()
                    .AddColumn("Option")
                    .AddColumn("Description")
                    .AddRow("1", "🔍 Global Search")
                    .AddRow("2", "📋 Vault Overview")
                    .AddRow("3", "🏗️  Select Vault")
                    .AddRow("4", "🔄 Update Cache")
                    .AddRow("5", "⚠️  Show Alerts")
                    .AddRow("6", "📊 Cache Status")
                    .AddRow("7", "❓ Help")
            )
            {
                Header = new PanelHeader("Main Menu"),
                Border = BoxBorder.Rounded
            };
            
            AnsiConsole.Write(panel);
        }

        private async Task RenderVaultOverview()
        {
            if (_keyVaultManager == null)
            {
                AnsiConsole.MarkupLine("[red]No vault selected. Use global search or select a vault.[/]");
                return;
            }

            try
            {
                var secrets = new List<string>();
                var keys = new List<string>();
                var certificates = new List<string>();

                // Get resource counts
                var secretCount = 0;
                var keyCount = 0;
                var certCount = 0;

                try
                {
                    // Use reflection to access private fields for now
                    var secretClientField = typeof(KeyVaultManager).GetField("_secretClient", 
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                    var secretClient = secretClientField?.GetValue(_keyVaultManager) as SecretClient;
                    
                    if (secretClient != null)
                    {
                        var secretProps = secretClient.GetPropertiesOfSecretsAsync();
                        await foreach (var secret in secretProps)
                        {
                            secrets.Add(secret.Name);
                            secretCount++;
                        }
                    }
                }
                catch { /* Ignore errors */ }

                try
                {
                    var keyClientField = typeof(KeyVaultManager).GetField("_keyClient", 
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                    var keyClient = keyClientField?.GetValue(_keyVaultManager) as KeyClient;
                    
                    if (keyClient != null)
                    {
                        var keyProps = keyClient.GetPropertiesOfKeysAsync();
                        await foreach (var key in keyProps)
                        {
                            keys.Add(key.Name);
                            keyCount++;
                        }
                    }
                }
                catch { /* Ignore errors */ }

                try
                {
                    var certClientField = typeof(KeyVaultManager).GetField("_certificateClient", 
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                    var certClient = certClientField?.GetValue(_keyVaultManager) as CertificateClient;
                    
                    if (certClient != null)
                    {
                        var certProps = certClient.GetPropertiesOfCertificatesAsync();
                        await foreach (var cert in certProps)
                        {
                            certificates.Add(cert.Name);
                            certCount++;
                        }
                    }
                }
                catch { /* Ignore errors */ }

                var table = new Table()
                    .AddColumn("Resource Type")
                    .AddColumn("Count")
                    .AddColumn("Sample Names")
                    .AddRow("🔐 Secrets", secretCount.ToString(), string.Join(", ", secrets.Take(3)))
                    .AddRow("🔑 Keys", keyCount.ToString(), string.Join(", ", keys.Take(3)))
                    .AddRow("📜 Certificates", certCount.ToString(), string.Join(", ", certificates.Take(3)));

                var panel = new Panel(table)
                {
                    Header = new PanelHeader($"Vault: {_navigation.SelectedVaultName}"),
                    Border = BoxBorder.Rounded
                };

                AnsiConsole.Write(panel);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error loading vault overview: {ex.Message}[/]");
            }
        }

        private async Task RenderSecrets()
        {
            if (_keyVaultManager == null) return;

            try
            {
                var secrets = new List<string>();
                
                var secretClientField = typeof(KeyVaultManager).GetField("_secretClient", 
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                var secretClient = secretClientField?.GetValue(_keyVaultManager) as SecretClient;
                
                if (secretClient != null)
                {
                    var secretProps = secretClient.GetPropertiesOfSecretsAsync();
                    await foreach (var secret in secretProps)
                    {
                        secrets.Add(secret.Name);
                    }
                }

                if (secrets.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No secrets found in this vault.[/]");
                    return;
                }

                var table = new Table()
                    .AddColumn("Name")
                    .AddColumn("Enabled")
                    .AddColumn("Created");

                foreach (var secret in secrets.Take(10)) // Show first 10
                {
                    table.AddRow(secret, "✅", "N/A");
                }

                if (secrets.Count > 10)
                {
                    table.AddRow($"... and {secrets.Count - 10} more", "", "");
                }

                var panel = new Panel(table)
                {
                    Header = new PanelHeader("Secrets"),
                    Border = BoxBorder.Rounded
                };

                AnsiConsole.Write(panel);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error loading secrets: {ex.Message}[/]");
            }
        }

        private async Task RenderKeys()
        {
            if (_keyVaultManager == null) return;

            try
            {
                var keys = new List<string>();
                
                var keyClientField = typeof(KeyVaultManager).GetField("_keyClient", 
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                var keyClient = keyClientField?.GetValue(_keyVaultManager) as KeyClient;
                
                if (keyClient != null)
                {
                    var keyProps = keyClient.GetPropertiesOfKeysAsync();
                    await foreach (var key in keyProps)
                    {
                        keys.Add(key.Name);
                    }
                }

                if (keys.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No keys found in this vault.[/]");
                    return;
                }

                var table = new Table()
                    .AddColumn("Name")
                    .AddColumn("Enabled")
                    .AddColumn("Created");

                foreach (var key in keys.Take(10)) // Show first 10
                {
                    table.AddRow(key, "✅", "N/A");
                }

                if (keys.Count > 10)
                {
                    table.AddRow($"... and {keys.Count - 10} more", "", "");
                }

                var panel = new Panel(table)
                {
                    Header = new PanelHeader("Keys"),
                    Border = BoxBorder.Rounded
                };

                AnsiConsole.Write(panel);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error loading keys: {ex.Message}[/]");
            }
        }

        private async Task RenderCertificates()
        {
            if (_keyVaultManager == null) return;

            try
            {
                var certificates = new List<string>();
                
                var certClientField = typeof(KeyVaultManager).GetField("_certificateClient", 
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                var certClient = certClientField?.GetValue(_keyVaultManager) as CertificateClient;
                
                if (certClient != null)
                {
                    var certProps = certClient.GetPropertiesOfCertificatesAsync();
                    await foreach (var cert in certProps)
                    {
                        certificates.Add(cert.Name);
                    }
                }

                if (certificates.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No certificates found in this vault.[/]");
                    return;
                }

                var table = new Table()
                    .AddColumn("Name")
                    .AddColumn("Enabled")
                    .AddColumn("Created");

                foreach (var cert in certificates.Take(10)) // Show first 10
                {
                    table.AddRow(cert, "✅", "N/A");
                }

                if (certificates.Count > 10)
                {
                    table.AddRow($"... and {certificates.Count - 10} more", "", "");
                }

                var panel = new Panel(table)
                {
                    Header = new PanelHeader("Certificates"),
                    Border = BoxBorder.Rounded
                };

                AnsiConsole.Write(panel);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error loading certificates: {ex.Message}[/]");
            }
        }

        private void RenderGlobalSearch()
        {
            // Fuzzy search input
            var searchTerm = AnsiConsole.Prompt(
                new TextPrompt<string>("[bold]Enter search term (or leave blank to cancel):[/]")
                    .AllowEmpty()
                    .PromptStyle("green")
            );
            if (string.IsNullOrWhiteSpace(searchTerm)) return;

            var results = _cacheManager.GlobalSearch(searchTerm);
            
            if (results.Count == 0)
            {
                AnsiConsole.MarkupLine("[yellow]No results found.[/]");
                AnsiConsole.MarkupLine("[dim]Press any key to return...[/]");
                Console.ReadKey(true);
                return;
            }

            // Prepare choices for selection
            var choices = results.Take(50).Select(r => $"{r.ResourceType.ToUpper()} | {r.Name} | {r.VaultUrl.Split('/')[2]}").ToList();
            if (results.Count > 50)
                choices.Add($"... and {results.Count - 50} more");

            var selected = AnsiConsole.Prompt(
                new SelectionPrompt<string>()
                    .Title("[bold]Select a resource to view details:[/]")
                    .PageSize(15)
                    .AddChoices(choices)
            );

            if (selected.StartsWith("... and "))
                return;

            var selectedResource = results.First(r => $"{r.ResourceType.ToUpper()} | {r.Name} | {r.VaultUrl.Split('/')[2]}" == selected);

            // Show details panel
            RenderResourceDetails(selectedResource);

            // Option to jump to vault overview
            if (AnsiConsole.Confirm("Jump to this vault's overview?", false))
            {
                _navigation.SelectedVaultUrl = selectedResource.VaultUrl;
                _navigation.SelectedVaultName = selectedResource.VaultUrl.Split('/')[2];
                _navigation.CurrentView = ViewType.VaultOverview;
                _navigation.Breadcrumbs.Clear();
                _navigation.Breadcrumbs.Add("Vault Overview");
            }
        }

        private void RenderResourceDetails(CachedResource resource)
        {
            var table = new Table()
                .AddColumn("Property")
                .AddColumn("Value")
                .AddRow("Vault", resource.VaultUrl)
                .AddRow("Type", resource.ResourceType)
                .AddRow("Name", resource.Name)
                .AddRow("Created", resource.Created?.ToString("yyyy-MM-dd") ?? "Unknown")
                .AddRow("Expires", resource.ExpiresOn?.ToString("yyyy-MM-dd") ?? "N/A")
                .AddRow("Enabled", resource.Enabled ? "Yes" : "No")
                .AddRow("Status", resource.GetExpirationStatus());

            var panel = new Panel(table)
            {
                Header = new PanelHeader($"Resource Details: {resource.Name}"),
                Border = BoxBorder.Rounded
            };

            AnsiConsole.Write(panel);
            AnsiConsole.MarkupLine("[dim]Press any key to continue...[/]");
            Console.ReadKey(true);
        }

        private void RenderCacheStatus()
        {
            var cacheSize = _cacheManager.GetCacheSize();
            var expiringCerts = _cacheManager.GetExpiringCertificates();

            var table = new Table()
                .AddColumn("Metric")
                .AddColumn("Value")
                .AddRow("Cached Vaults", cacheSize.ToString())
                .AddRow("Expiring Certificates", expiringCerts.Count.ToString());

            var panel = new Panel(table)
            {
                Header = new PanelHeader("Cache Status"),
                Border = BoxBorder.Rounded
            };

            AnsiConsole.Write(panel);
        }

        private void RenderAlerts()
        {
            var expiringCerts = _cacheManager.GetExpiringCertificates();

            if (expiringCerts.Count == 0)
            {
                AnsiConsole.MarkupLine("[green]No expiring certificates found.[/]");
                return;
            }

            var table = new Table()
                .AddColumn("Vault")
                .AddColumn("Certificate")
                .AddColumn("Status")
                .AddColumn("Expires");

            foreach (var cert in expiringCerts.Take(10))
            {
                table.AddRow(
                    cert.VaultUrl.Split('/')[2],
                    cert.Name,
                    cert.GetExpirationStatus(),
                    cert.ExpiresOn?.ToString("yyyy-MM-dd") ?? "Unknown"
                );
            }

            if (expiringCerts.Count > 10)
            {
                table.AddRow("", "", $"... and {expiringCerts.Count - 10} more", "");
            }

            var panel = new Panel(table)
            {
                Header = new PanelHeader("Expiring Certificates"),
                Border = BoxBorder.Rounded
            };

            AnsiConsole.Write(panel);
        }

        private async Task HandleInput()
        {
            var key = Console.ReadKey(true);

            switch (_navigation.CurrentView)
            {
                case ViewType.MainMenu:
                    await HandleMainMenuInput(key);
                    break;
                case ViewType.VaultSelect:
                    HandleVaultSelectInput(key);
                    break;
                case ViewType.VaultOverview:
                    HandleVaultOverviewInput(key);
                    break;
                case ViewType.Secrets:
                case ViewType.Keys:
                case ViewType.Certificates:
                    await HandleResourceViewInput(key);
                    break;
                case ViewType.GlobalSearch:
                case ViewType.CacheStatus:
                case ViewType.Alerts:
                    HandleSimpleViewInput(key);
                    break;
            }
        }

        private async Task HandleMainMenuInput(ConsoleKeyInfo key)
        {
            switch (key.KeyChar)
            {
                case '1':
                    _navigation.CurrentView = ViewType.GlobalSearch;
                    _navigation.Breadcrumbs.Clear();
                    _navigation.Breadcrumbs.Add("Global Search");
                    break;
                case '2':
                    if (_keyVaultManager != null)
                    {
                        _navigation.CurrentView = ViewType.VaultOverview;
                        _navigation.Breadcrumbs.Clear();
                        _navigation.Breadcrumbs.Add("Vault Overview");
                    }
                    else
                    {
                        AnsiConsole.MarkupLine("[yellow]No vault selected. Use global search first.[/]");
                        await Task.Delay(2000);
                    }
                    break;
                case '3':
                    _navigation.CurrentView = ViewType.VaultSelect;
                    _navigation.Breadcrumbs.Clear();
                    _navigation.Breadcrumbs.Add("Vault Select");
                    break;
                case '4':
                    await UpdateCache();
                    break;
                case '5':
                    _navigation.CurrentView = ViewType.Alerts;
                    _navigation.Breadcrumbs.Clear();
                    _navigation.Breadcrumbs.Add("Alerts");
                    break;
                case '6':
                    _navigation.CurrentView = ViewType.CacheStatus;
                    _navigation.Breadcrumbs.Clear();
                    _navigation.Breadcrumbs.Add("Cache Status");
                    break;
                case '7':
                    ShowHelp();
                    break;
            }

            if (key.Key == ConsoleKey.Escape)
            {
                _isRunning = false;
            }
        }

        private void HandleVaultSelectInput(ConsoleKeyInfo key)
        {
            if (key.Key == ConsoleKey.Escape)
            {
                GoBack();
            }
        }

        private void HandleVaultOverviewInput(ConsoleKeyInfo key)
        {
            switch (key.KeyChar)
            {
                case 's':
                case 'S':
                    _navigation.CurrentView = ViewType.Secrets;
                    _navigation.Breadcrumbs.Add("Secrets");
                    break;
                case 'k':
                case 'K':
                    _navigation.CurrentView = ViewType.Keys;
                    _navigation.Breadcrumbs.Add("Keys");
                    break;
                case 'c':
                case 'C':
                    _navigation.CurrentView = ViewType.Certificates;
                    _navigation.Breadcrumbs.Add("Certificates");
                    break;
                case 'g':
                case 'G':
                    _navigation.CurrentView = ViewType.GlobalSearch;
                    _navigation.Breadcrumbs.Add("Global Search");
                    break;
                case 'a':
                case 'A':
                    _navigation.CurrentView = ViewType.Alerts;
                    _navigation.Breadcrumbs.Add("Alerts");
                    break;
            }

            if (key.Key == ConsoleKey.Escape)
            {
                GoBack();
            }
        }

        private async Task HandleResourceViewInput(ConsoleKeyInfo key)
        {
            switch (key.KeyChar)
            {
                case 's':
                case 'S':
                    await HandleSearchInCurrentView();
                    break;
                case 'r':
                case 'R':
                    // Refresh current view
                    break;
            }

            if (key.Key == ConsoleKey.Escape)
            {
                GoBack();
            }
        }

        private async Task HandleSearchInCurrentView()
        {
            if (_keyVaultManager == null) return;

            var searchTerm = AnsiConsole.Prompt(
                new TextPrompt<string>("[bold]Enter search term:[/]")
                    .AllowEmpty()
                    .PromptStyle("green")
            );

            if (string.IsNullOrWhiteSpace(searchTerm)) return;

            try
            {
                var results = await _keyVaultManager.SearchAllResources(searchTerm);
                
                if (results.Count == 0)
                {
                    AnsiConsole.MarkupLine("[yellow]No results found in current vault.[/]");
                    AnsiConsole.MarkupLine("[dim]Press any key to continue...[/]");
                    Console.ReadKey(true);
                    return;
                }

                // Show results in a table
                var table = new Table()
                    .AddColumn("Type")
                    .AddColumn("Name");

                foreach (var result in results.Take(20)) // Limit to 20 results
                {
                    table.AddRow(result.type, result.name);
                }

                if (results.Count > 20)
                {
                    table.AddRow($"... and {results.Count - 20} more", "");
                }

                var panel = new Panel(table)
                {
                    Header = new PanelHeader($"Search Results for '{searchTerm}'"),
                    Border = BoxBorder.Rounded
                };

                AnsiConsole.Write(panel);
                AnsiConsole.MarkupLine("[dim]Press any key to continue...[/]");
                Console.ReadKey(true);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Search error: {ex.Message}[/]");
                AnsiConsole.MarkupLine("[dim]Press any key to continue...[/]");
                Console.ReadKey(true);
            }
        }

        private void HandleSimpleViewInput(ConsoleKeyInfo key)
        {
            if (key.Key == ConsoleKey.Escape)
            {
                GoBack();
            }
        }

        private void GoBack()
        {
            if (_navigation.Breadcrumbs.Count > 0)
            {
                _navigation.Breadcrumbs.RemoveAt(_navigation.Breadcrumbs.Count - 1);
            }

            if (_navigation.Breadcrumbs.Count == 0)
            {
                _navigation.CurrentView = ViewType.MainMenu;
            }
            else
            {
                // Determine view based on breadcrumbs
                var lastBreadcrumb = _navigation.Breadcrumbs[^1];
                _navigation.CurrentView = lastBreadcrumb switch
                {
                    "Vault Overview" => ViewType.VaultOverview,
                    "Secrets" => ViewType.Secrets,
                    "Keys" => ViewType.Keys,
                    "Certificates" => ViewType.Certificates,
                    "Global Search" => ViewType.GlobalSearch,
                    "Alerts" => ViewType.Alerts,
                    "Cache Status" => ViewType.CacheStatus,
                    _ => ViewType.MainMenu
                };
            }
        }

        private async Task UpdateCache()
        {
            if (_keyVaultManager != null)
            {
                // Update cache for specific vault
                await _keyVaultManager.UpdateCache();
                AnsiConsole.MarkupLine("[green]Cache updated for current vault.[/]");
            }
            else
            {
                // Global cache update
                await UpdateGlobalCache();
            }
            
            await Task.Delay(2000);
        }

        private async Task UpdateGlobalCache()
        {
            AnsiConsole.MarkupLine("[bold blue]🔄 Updating global cache...[/]");
            AnsiConsole.MarkupLine("[yellow]This may take a while for large environments.[/]");
            
            try
            {
                var credential = new DefaultAzureCredential();
                
                // Get all subscriptions
                var subscriptions = await GetSubscriptions();
                if (subscriptions.Count == 0)
                {
                    AnsiConsole.MarkupLine("[red]No subscriptions found or access denied.[/]");
                    return;
                }

                var totalVaults = 0;
                var updatedVaults = 0;

                foreach (var subscription in subscriptions)
                {
                    AnsiConsole.MarkupLine($"[dim]Processing subscription: {subscription.name}[/]");
                    
                    try
                    {
                        // Get all Key Vaults in this subscription
                        var vaults = await GetKeyVaults(subscription.id);
                        
                        foreach (var vault in vaults)
                        {
                            totalVaults++;
                            var vaultUrl = $"https://{vault.name}.vault.azure.net/";
                            
                            try
                            {
                                // Create a temporary KeyVaultManager for this vault
                                var tempManager = new KeyVaultManager(vaultUrl, credential, _cacheManager);
                                await tempManager.UpdateCache();
                                
                                updatedVaults++;
                            }
                            catch (Exception ex)
                            {
                                AnsiConsole.MarkupLine($"[red]Failed to update vault {vault.name}: {ex.Message}[/]");
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        AnsiConsole.MarkupLine($"[red]Failed to process subscription {subscription.name}: {ex.Message}[/]");
                    }
                }

                AnsiConsole.MarkupLine($"[green]✅ Global cache update complete:[/] {updatedVaults}/{totalVaults} vaults updated");
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]❌ Global cache update failed:[/] {ex.Message}");
            }
        }

        private async Task<List<(string id, string name)>> GetSubscriptions()
        {
            try
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
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting subscriptions:[/] {ex.Message}");
                return new List<(string, string)>();
            }
        }

        private async Task<List<(string name, string location, string resourceGroup)>> GetKeyVaults(string subscriptionId)
        {
            try
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
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error getting Key Vaults:[/] {ex.Message}");
                return new List<(string, string, string)>();
            }
        }

        private void ShowHelp()
        {
            var helpText = @"
[bold]Keyboard Shortcuts:[/]
• [ESC] - Go back / Quit
• [1-7] - Select menu option
• [S] - Search / Secrets
• [K] - Keys
• [C] - Certificates
• [G] - Global Search
• [A] - Alerts
• [R] - Refresh
• [Q] - Quit

[bold]Navigation:[/]
• Use arrow keys or numbers to navigate
• ESC to go back one level
• Always shows current context in breadcrumbs
            ";

            var panel = new Panel(helpText)
            {
                Header = new PanelHeader("Help"),
                Border = BoxBorder.Rounded
            };

            AnsiConsole.Write(panel);
            AnsiConsole.WriteLine();
            AnsiConsole.MarkupLine("[dim]Press any key to continue...[/]");
            Console.ReadKey(true);
        }

        private async Task RenderVaultSelect()
        {
            AnsiConsole.MarkupLine("[bold blue]🏗️  Select a Key Vault[/]");
            AnsiConsole.WriteLine();

            try
            {
                // Get all subscriptions
                var subscriptions = await GetSubscriptions();
                if (subscriptions.Count == 0)
                {
                    AnsiConsole.MarkupLine("[red]No subscriptions found. Make sure you are logged in with 'az login'.[/]");
                    AnsiConsole.MarkupLine("[dim]Press any key to return...[/]");
                    Console.ReadKey(true);
                    return;
                }

                // Let user select subscription
                var subscriptionChoices = subscriptions.Select(s => $"{s.name} ({s.id})").ToList();
                var selectedSubscription = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Choose a subscription:")
                        .PageSize(10)
                        .AddChoices(subscriptionChoices)
                );

                var subscription = subscriptions.First(s => $"{s.name} ({s.id})" == selectedSubscription);
                AnsiConsole.MarkupLine($"[green]Selected subscription:[/] {subscription.name}");

                // Get Key Vaults in the selected subscription
                var vaults = await GetKeyVaults(subscription.id);
                if (vaults.Count == 0)
                {
                    AnsiConsole.MarkupLine($"[yellow]No Key Vaults found in subscription '{subscription.name}'.[/]");
                    AnsiConsole.MarkupLine("[dim]Press any key to return...[/]");
                    Console.ReadKey(true);
                    return;
                }

                // Let user select Key Vault
                var vaultChoices = vaults.Select(v => $"{v.name} ({v.resourceGroup}, {v.location})").ToList();
                var selectedVault = AnsiConsole.Prompt(
                    new SelectionPrompt<string>()
                        .Title("Choose a Key Vault:")
                        .PageSize(10)
                        .AddChoices(vaultChoices)
                );

                var vault = vaults.First(v => $"{v.name} ({v.resourceGroup}, {v.location})" == selectedVault);
                var vaultUrl = $"https://{vault.name}.vault.azure.net/";

                // Create KeyVaultManager for the selected vault
                try
                {
                    var credential = new DefaultAzureCredential();
                    _keyVaultManager = new KeyVaultManager(vaultUrl, credential, _cacheManager);
                    
                    _navigation.SelectedVaultUrl = vaultUrl;
                    _navigation.SelectedVaultName = vault.name;
                    
                    AnsiConsole.MarkupLine($"[green]✅ Successfully connected to vault:[/] {vault.name}");
                    AnsiConsole.MarkupLine("[dim]Press any key to continue...[/]");
                    Console.ReadKey(true);
                    
                    // Navigate to vault overview
                    _navigation.CurrentView = ViewType.VaultOverview;
                    _navigation.Breadcrumbs.Clear();
                    _navigation.Breadcrumbs.Add("Vault Overview");
                }
                catch (Exception ex)
                {
                    AnsiConsole.MarkupLine($"[red]❌ Failed to connect to vault:[/] {ex.Message}");
                    AnsiConsole.MarkupLine("[dim]Press any key to return...[/]");
                    Console.ReadKey(true);
                }
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Error during vault selection:[/] {ex.Message}");
                AnsiConsole.MarkupLine("[dim]Press any key to return...[/]");
                Console.ReadKey(true);
            }
        }
    }
} 