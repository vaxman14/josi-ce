using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Josi.Native {
  static class PcTerminalView {
    public static void Show(Window owner) {
      var window=new Window {Owner=owner,Title="Josi terminal sessions",Width=900,Height=560,Background=Ui.Backdrop,Foreground=Ui.Text,FontFamily=Ui.Font,WindowStartupLocation=WindowStartupLocation.CenterOwner};
      var choice=new ComboBox {MinWidth=300};
      var output=new TextBox {IsReadOnly=true,AcceptsReturn=true,TextWrapping=TextWrapping.NoWrap,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Auto,FontFamily=new System.Windows.Media.FontFamily("Consolas"),FontSize=13,Background=Ui.Backdrop,Foreground=Ui.Text,Margin=new Thickness(0,12,0,0)};
      var root=new DockPanel {Margin=new Thickness(20)};
      var header=Ui.Row(10,choice,Ui.Danger("Close terminal",()=>{if(choice.SelectedItem is string id)PcTerminals.Close(id);}),Ui.Pill("Close all",()=>PcTerminals.StopAll()));
      DockPanel.SetDock(header,Dock.Top);root.Children.Add(header);root.Children.Add(output);window.Content=root;
      var timer=new DispatcherTimer {Interval=TimeSpan.FromSeconds(1)};
      void Refresh(){
        var sessions=PcTerminals.Snapshot().Select(Wires.Serialize).Select(Wires.Parse).ToList();
        var selected=choice.SelectedItem as string;var ids=sessions.Select(s=>s["sessionId"].Text).ToList();
        if(choice.ItemsSource is not List<string> existing||!existing.SequenceEqual(ids)){choice.ItemsSource=ids;choice.SelectedItem=ids.Contains(selected)?selected:ids.FirstOrDefault();}
        var session=sessions.FirstOrDefault(s=>s["sessionId"].Text==(choice.SelectedItem as string));
        var text=session==null?"No terminal sessions. Ask Josi in chat to open one.":Regex.Replace(session["output"].Text,@"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07))","");
        if(output.Text!=text){output.Text=text;output.ScrollToEnd();}
      }
      choice.SelectionChanged+=(_,__)=>Refresh();timer.Tick+=(_,__)=>Refresh();
      window.Closed+=(_,__)=>timer.Stop();Refresh();timer.Start();window.Show();
    }
  }
}
