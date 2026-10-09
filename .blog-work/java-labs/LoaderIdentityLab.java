import java.io.InputStream;
import java.io.IOException;

public class LoaderIdentityLab {
    public static class Payload {
        public Payload() {}
        public String value() { return "hello"; }
    }
    static final class IsolatedLoader extends ClassLoader {
        private final String target;
        private final byte[] bytes;
        IsolatedLoader(String target, byte[] bytes) {
            super(LoaderIdentityLab.class.getClassLoader());
            this.target=target;
            this.bytes=bytes.clone();
        }
        @Override
        protected Class<?> loadClass(String name, boolean resolve)
                throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> type=findLoadedClass(name);
                if (type==null) {
                    if (name.equals(target)) {
                        type=defineClass(name,bytes,0,bytes.length);
                    } else {
                        type=super.loadClass(name,false);
                    }
                }
                if (resolve) resolveClass(type);
                return type;
            }
        }
    }
    public static void main(String[] args) throws Exception {
        String name=Payload.class.getName();
        String resource="/"+name.replace('.','/')+".class";
        byte[] bytes;
        try (InputStream input=LoaderIdentityLab.class.getResourceAsStream(resource)) {
            if (input==null) throw new IOException("missing resource: "+resource);
            bytes=input.readAllBytes();
        }
        Class<?> first=new IsolatedLoader(name,bytes).loadClass(name);
        Class<?> second=new IsolatedLoader(name,bytes).loadClass(name);
        Object value=first.getConstructor().newInstance();
        System.out.println("same name="+first.getName().equals(second.getName()));
        System.out.println("same class="+(first==second));
        System.out.println("assignable="+second.isInstance(value));
        try {
            second.cast(value);
            throw new AssertionError("unexpected cast success");
        } catch (ClassCastException expected) {
            System.out.println("different defining loaders: cast rejected");
        }
    }
}